// doppler run --project hackathon --config dev -- pnpm exec tsx src/runner/cli.ts <command> [flags]
//
// --binding is a module path whose default export is an AgentBinding, or (profile) => AgentBinding.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Profile } from '../contract/types';
import { retrieveAccepted } from '../memory/index';
import { pgDb } from './db';
import { acceptDecision, correct, settleVerification, verifyFresh } from './fresh';
import { approve, resumeRun, runAgent, type AgentBinding } from './run';

const USAGE = `commands:
  retrieve     --profile P
  run          --profile P --task T --binding MODULE [--baseline] [--technique ID] [--repair-budget N]
  status       --run ID
  approve      --evaluation ID --decision approved|rejected --by NAME [--note TEXT]
  resume       --run ID --binding MODULE
  correct      --finding ID --by NAME [--statement TEXT]
  accept       --decision ID --by NAME
  verify-fresh --finding ID --profile P --task T --binding MODULE
  settle       --finding ID`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: 'string' }, task: { type: 'string' }, binding: { type: 'string' }, baseline: { type: 'boolean' },
    technique: { type: 'string' }, 'repair-budget': { type: 'string' }, run: { type: 'string' }, evaluation: { type: 'string' },
    decision: { type: 'string' }, by: { type: 'string' }, note: { type: 'string' }, finding: { type: 'string' }, statement: { type: 'string' },
  },
});

function need(name: keyof typeof flags): string {
  const value = flags[name];
  if (typeof value !== 'string' || !value) throw new Error(`--${name} is required\n${USAGE}`);
  return value;
}

async function loadBinding(profile?: Profile): Promise<AgentBinding> {
  const mod = await import(pathToFileURL(resolve(need('binding'))).href);
  const exported = mod.default as AgentBinding | ((p?: Profile) => AgentBinding);
  return typeof exported === 'function' ? exported(profile) : exported;
}

const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function main() {
  const command = positionals[0];
  if (!command) throw new Error(USAGE);
  const db = pgDb();
  try {
    switch (command) {
      case 'retrieve':
        return print(await retrieveAccepted(db, need('profile') as Profile));
      case 'run': {
        const profile = need('profile') as Profile;
        const report = await runAgent(db, {
          profile, task: need('task'), binding: await loadBinding(profile),
          memoryMode: flags.baseline ? 'baseline' : 'on',
          ...(flags.technique ? { techniqueId: flags.technique } : {}),
          ...(flags['repair-budget'] ? { repairBudget: Number(flags['repair-budget']) } : {}),
        });
        print(report);
        if (report.status !== 'completed') process.exitCode = 1;
        return;
      }
      case 'status':
        return print(await db.withRole('dashboard_reader', (tx) => tx.query(`select * from cm.v_run_status where run_id = $1::uuid`, [need('run')])));
      case 'approve':
        await approve(db, {
          evaluationId: need('evaluation'), decision: need('decision') as 'approved' | 'rejected', approver: need('by'),
          ...(flags.note ? { note: flags.note } : {}),
        });
        return print({ ok: true });
      case 'resume': {
        const report = await resumeRun(db, { runId: need('run'), binding: await loadBinding() });
        print(report);
        if (report.status !== 'completed') process.exitCode = 1;
        return;
      }
      case 'correct':
        return print(await correct(db, {
          findingId: need('finding'), proposedBy: need('by'),
          ...(flags.statement ? { statement: flags.statement } : {}),
        }));
      case 'accept':
        await acceptDecision(db, { decisionId: need('decision'), acceptedBy: need('by') });
        return print({ ok: true });
      case 'verify-fresh': {
        const profile = need('profile') as Profile;
        const result = await verifyFresh(db, { findingId: need('finding'), profile, task: need('task'), binding: await loadBinding(profile) });
        print(result);
        if (!result.verified) process.exitCode = 1;
        return;
      }
      case 'settle':
        return print({ verified: await settleVerification(db, need('finding')) });
      default:
        throw new Error(`unknown command ${command}\n${USAGE}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
