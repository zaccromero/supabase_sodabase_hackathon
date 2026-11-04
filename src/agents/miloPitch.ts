// Milo pitch agent. Revises one slide's text. The default source is the curated source-packet
// excerpt; a task naming "slide NN" reads that slide from the deck of record through ROOM.md.
// The deck is NOT_FOR_DISTRIBUTION: only the chosen text reaches the model, and text or a
// revision carrying a financial figure is refused in code.
//
// The packet holds two things the model must not see: its authored suggested_revision, because
// the handler must generate its own, and its label calling the claim superseded, because that
// would hand the correction to a baseline run. Both stay in code and evidence only.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../contract/hash.js';
import type { EvidenceInput, Handler } from '../contract/types.js';
import { AgentOutputError, type ModelClient, ModelTrace, structuredCall } from './model.js';
import { buildSystemPrompt, withTechnique } from './prompt.js';

export const DEFAULT_INVESTORS_DIR = '/Users/zaccromero/code/projects/milo.ai/docs/investors';
export const DEFAULT_SLIDE_ID = '07';
export const DEFAULT_SLIDE_PACKET = fileURLToPath(new URL('../../data/curated/milo-slide-text.json', import.meta.url));

const ROLE = `You are the Milo pitch agent. You revise the text of one investor-deck slide.

Change only what the task asks for and keep the slide's structure and length. List a claim for each factual statement you can tie to one of the allowed sources you are given, using its key exactly. The text being revised is not a source and must never be cited: a draft cannot support itself. Do not add market sizes, prices, revenue, fundraising amounts or any other financial figure. Do not invent traction, usage, customers or partnerships.`;

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

function chooseSlide(requested: string, slides: Slide[]): Slide {
  const slide = slides.find((candidate) => candidate.id === requested);
  if (!slide) throw new AgentOutputError(`Deck has no slide ${requested}`);
  return slide;
}

interface SlidePacket {
  id: string;
  distribution: string;
  historical_input: { source_id: string; label: string; text: string };
  task: string;
  suggested_revision?: { label?: string; title?: string; body?: string };
}

/** What a revision works from, whichever source it came from. */
interface RevisionSource {
  slideId: string;
  before: string;
  sources: Array<[string, string]>;
  instructions: string;
  mustNotCopy: string[];
  evidence: EvidenceInput;
}

function deckSource(investorsDir: string, slideId: string, technique: boolean): RevisionSource {
  const deck = loadCurrentDeck(investorsDir);
  const slide = chooseSlide(slideId, deck.slides);
  assertNoFinancialFigures(slide);
  const before = slideText(slide);
  const payload = { deck_version: deck.version, deck_status: deck.status, deck_sha256: deck.sha256, slide_id: slide.id, before_sha256: sha256(before), technique_used: technique };
  return {
    slideId: slide.id,
    before,
    sources: Object.entries(deck.sources),
    instructions: '',
    mustNotCopy: [],
    evidence: { kind: 'deck_source', uri: deck.path, sha256: deck.sha256, payload },
  };
}

function packetSource(path: string, technique: boolean): RevisionSource {
  const raw = readFileSync(path);
  const packet = JSON.parse(raw.toString('utf8')) as SlidePacket;
  const before = packet.historical_input.text;
  const figure = before.match(FINANCIAL_FIGURE);
  if (figure) throw new AgentOutputError(`Slide packet ${packet.id} contains a financial figure ("${figure[0]}") and cannot be used`);
  const fileSha = createHash('sha256').update(raw).digest('hex');
  const payload = {
    packet_id: packet.id,
    distribution: packet.distribution,
    source_id: packet.historical_input.source_id,
    historical_label: packet.historical_input.label,
    historical: true,
    packet_sha256: fileSha,
    before_sha256: sha256(before),
    technique_used: technique,
  };
  return {
    slideId: packet.id,
    before,
    sources: [],
    instructions: `Return only a title and a body, with the title on the first line of "after". No financial figures or usage claims.`,
    mustNotCopy: [packet.suggested_revision?.title, packet.suggested_revision?.body].filter((text): text is string => !!text),
    evidence: { kind: 'slide_source', uri: path, sha256: fileSha, payload },
  };
}

const folded = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

export function createMiloPitch(deps: { model: () => ModelClient; investorsDir?: string; slidePacketPath?: string }): Handler {
  return async ({ task, decisions, repairNotes, technique }) => {
    const namedSlide = task.match(/\bslide\s+(\d{1,2})\b/i)?.[1]?.padStart(2, '0');
    const source = namedSlide
      ? deckSource(deps.investorsDir ?? process.env.MILO_INVESTORS_DIR ?? DEFAULT_INVESTORS_DIR, namedSlide, technique !== undefined)
      : packetSource(deps.slidePacketPath ?? process.env.MILO_SLIDE_PACKET ?? DEFAULT_SLIDE_PACKET, technique !== undefined);
    const trace = new ModelTrace(deps.model());
    const system = buildSystemPrompt(ROLE, decisions, repairNotes);

    const allowedSources = new Map<string, string>([
      ...source.sources,
      ...decisions.map((d): [string, string] => [d.source_uri, `source of pinned decision ${d.decision_key}`]),
    ]);
    const sourceList = allowedSources.size > 0
      ? `Allowed claim sources (use the exact key before the colon):\n${[...allowedSources].map(([key, description]) => `- ${key}: ${description}`).join('\n')}`
      : 'No claim sources are available for this run. Return an empty claims list.';
    const user = withTechnique(
      [
        `Task: ${task}`,
        source.instructions,
        `Current text:\n<slide>\n${source.before}\n</slide>`,
        sourceList,
      ].filter(Boolean).join('\n\n'),
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
        if (source.mustNotCopy.some((text) => folded(revision.after).includes(folded(text)))) found.push('after copies authored text instead of generating a revision');
        if (allowedSources.size > 0 && revision.claims.length === 0) found.push('claims is empty: cite at least one allowed source');
        for (const claim of revision.claims) {
          if (!allowedSources.has(claim.source)) found.push(`claim source "${claim.source}" is not an allowed source key`);
        }
        return found;
      },
    });
    if (problems.length > 0) throw new AgentOutputError(`Milo revision rejected: ${problems.join('; ')}`);

    return {
      body: { slide_id: source.slideId, before: source.before, after: value.after, claims: value.claims },
      evidence: [source.evidence, trace.evidence(system, decisions.map((d) => d.id))],
    };
  };
}
