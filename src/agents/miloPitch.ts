// Milo pitch agent. Revises one slide's text from the current deck of record, found through
// ROOM.md. The deck is NOT_FOR_DISTRIBUTION: only the chosen slide reaches the model, and a
// slide or a revision carrying a financial figure is refused in code.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../contract/hash.js';
import type { Handler } from '../contract/types.js';
import { AgentOutputError, type ModelClient, ModelTrace, structuredCall } from './model.js';
import { buildSystemPrompt, withTechnique } from './prompt.js';

export const DEFAULT_INVESTORS_DIR = '/Users/zaccromero/code/projects/milo.ai/docs/investors';
export const DEFAULT_SLIDE_ID = '07';

const ROLE = `You are the Milo pitch agent. You revise the text of one investor-deck slide.

Change only what the task asks for and keep the slide's structure and length. Every factual statement in your revision needs a claim naming its source, chosen from the sources you are given. Do not add market sizes, prices, revenue, fundraising amounts or any other financial figure. Do not invent traction, customers or partnerships.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    after: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, source: { type: 'string' } },
        required: ['text', 'source'],
        additionalProperties: false,
      },
    },
  },
  required: ['after', 'claims'],
  additionalProperties: false,
};

type Slide = Record<string, unknown> & { id: string; claims?: Array<{ ledger?: string; shown?: string }> };
interface DeckSource { path: string; version: string; status: string; sha256: string; sources: Record<string, string>; slides: Slide[]; }
interface Revision { after: string; claims: Array<{ text: string; source: string }>; }

const FINANCIAL_FIGURE = /[$€£]\s?\d|\b\d[\d,.]*\s?(?:k|m|mm|million|billion|usd|dollars?)\b|\b\d+(?:\.\d+)?\s?%/i;

/** The current deck version comes from the Pitch deck row of the room index. */
export function loadCurrentDeck(investorsDir: string): DeckSource {
  const room = readFileSync(join(investorsDir, 'ROOM.md'), 'utf8');
  const row = room.split('\n').find((line) => /^\|\s*Pitch deck\b/.test(line));
  const version = row?.split('|')[4]?.trim();
  if (!version) throw new AgentOutputError('ROOM.md has no version for the pitch deck');
  const path = join(investorsDir, 'checkpoints', version, 'deck.json');
  const raw = readFileSync(path);
  const deck = JSON.parse(raw.toString('utf8')) as { status: string; sources: Record<string, string>; slides: Slide[] };
  return { path, version, status: deck.status, sha256: createHash('sha256').update(raw).digest('hex'), sources: deck.sources, slides: deck.slides };
}

const VISIBLE_FIELDS = ['kicker', 'label', 'hero', 'headline', 'sub', 'left_axis', 'right_axis', 'left', 'right', 'center', 'center_note', 'steps', 'rows', 'nodes', 'bands', 'gates', 'roles', 'cards', 'facts', 'allocation', 'cases', 'line_label', 'footer'];

/** The words shown on a slide, in reading order. Build metadata such as `job` is left out. */
export function slideText(slide: Slide): string {
  const lines: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') lines.push(value);
    else if (Array.isArray(value)) {
      if (value.every((item) => typeof item === 'string')) lines.push(value.join(' — '));
      else value.forEach(walk);
    } else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const field of VISIBLE_FIELDS) if (slide[field] !== undefined) walk(slide[field]);
  return lines.join('\n');
}

export function assertNoFinancialFigures(slide: Slide): void {
  if (slide.claims?.some((claim) => claim.ledger)) throw new AgentOutputError(`Slide ${slide.id} is bound to ledger figures and cannot be used`);
  const match = slideText(slide).match(FINANCIAL_FIGURE);
  if (match) throw new AgentOutputError(`Slide ${slide.id} contains a financial figure ("${match[0]}") and cannot be used`);
}

function chooseSlide(task: string, slides: Slide[]): Slide {
  const requested = task.match(/\bslide\s+(\d{1,2})\b/i)?.[1]?.padStart(2, '0') ?? DEFAULT_SLIDE_ID;
  const slide = slides.find((candidate) => candidate.id === requested);
  if (!slide) throw new AgentOutputError(`Deck has no slide ${requested}`);
  return slide;
}

export function createMiloPitch(deps: { model: () => ModelClient; investorsDir?: string }): Handler {
  return async ({ task, decisions, repairNotes, technique }) => {
    const deck = loadCurrentDeck(deps.investorsDir ?? process.env.MILO_INVESTORS_DIR ?? DEFAULT_INVESTORS_DIR);
    const slide = chooseSlide(task, deck.slides);
    assertNoFinancialFigures(slide);
    const before = slideText(slide);
    const trace = new ModelTrace(deps.model());
    const system = buildSystemPrompt(ROLE, decisions, repairNotes);

    const allowedSources = new Map<string, string>([
      [`deck.json#slide-${slide.id}`, 'the slide text itself'],
      ...Object.entries(deck.sources).map(([key, description]): [string, string] => [key, description]),
      ...decisions.map((d): [string, string] => [d.source_uri, `source of pinned decision ${d.decision_key}`]),
    ]);
    const sourceList = [...allowedSources].map(([key, description]) => `- ${key}: ${description}`).join('\n');
    const user = withTechnique(
      `Task: ${task}\n\nSlide ${slide.id}, current text:\n<slide>\n${before}\n</slide>\n\nAllowed claim sources (use the exact key before the colon):\n${sourceList}`,
      technique,
    );

    const { value, problems } = await structuredCall<Revision>({
      trace,
      system,
      user,
      schema: OUTPUT_SCHEMA,
      validate: (revision) => {
        const found: string[] = [];
        const figure = revision.after.match(FINANCIAL_FIGURE);
        if (figure) found.push(`after contains a financial figure: "${figure[0]}"`);
        if (!revision.after.trim()) found.push('after is empty');
        for (const claim of revision.claims) {
          if (!allowedSources.has(claim.source)) found.push(`claim source "${claim.source}" is not an allowed source key`);
        }
        return found;
      },
    });
    if (problems.length > 0) throw new AgentOutputError(`Milo revision rejected: ${problems.join('; ')}`);

    const sourcePayload = {
      deck_version: deck.version,
      deck_status: deck.status,
      deck_sha256: deck.sha256,
      slide_id: slide.id,
      before_sha256: sha256(before),
      technique_used: technique !== undefined,
    };
    return {
      body: { slide_id: slide.id, before, after: value.after, claims: value.claims },
      evidence: [
        { kind: 'deck_source', uri: deck.path, sha256: deck.sha256, payload: sourcePayload },
        trace.evidence(system, decisions.map((d) => d.id)),
      ],
    };
  };
}
