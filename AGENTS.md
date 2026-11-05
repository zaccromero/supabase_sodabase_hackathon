# Agent guide

This repository implements **Company Memory**: source-backed, versioned company decisions that can be retrieved by later agent runs and checked before the database allows completion.

## Start here

- Product: <https://company-memory-zacc-r.vercel.app/>
- Judge-facing workspace: <https://company-memory-zacc-r.vercel.app/app>
- Detailed evidence view: <https://company-memory-zacc-r.vercel.app/app?view=evidence>
- Final public demo video: <https://company-memory-demo-video.vercel.app/>
- Reviewer evidence map: [`docs/JUDGE-GUIDE.md`](docs/JUDGE-GUIDE.md)
- Machine-readable overview: [`llms.txt`](llms.txt)
- System contract: [`docs/CONTRACT.md`](docs/CONTRACT.md)
- Demo facts and fallback language: [`docs/DEMO.md`](docs/DEMO.md)

## What to explain

1. A source-backed decision is proposed and only a founder-authorized role can accept it.
2. A run pins the accepted decision and a frozen set of checks.
3. The agent output, output hash, evaluations and evidence are stored together.
4. The database gate reads the latest attempt and returns `completed`, `blocked` or `awaiting_approval`.
5. Sodabase data-quality findings remain separate from behavioral evaluation. A completed execution never erases a data-quality hold.

The public positioning example is an illustration. The detailed evidence view contains the retained runtime proof. Do not present the illustration as the output of the retained run.

## Evidence rules

- Keep `source`, `decision`, `output`, `checks` and `gate` distinct.
- Preserve run IDs, hashes, timestamps and source dates exactly.
- Label historical records, illustrations, replays and retained executions accurately.
- Missing or unreconciled data stays unknown; never convert it to zero.
- A failed latest attempt remains failed even when an earlier attempt completed.
- Do not expose private relationship, equity or restricted deck details on public/default routes.
- Do not claim production scale, a global Sodabase score, billing adoption or source-reel import without retained evidence.

## Working in the repository

- Read [`docs/CONTRACT.md`](docs/CONTRACT.md) before changing behavior or data contracts.
- Preserve the lane ownership table in the contract. Schema requests belong in `docs/migration-requests/`.
- Keep secrets in Doppler; never print them or commit local environment files.
- Production company repositories and production Gym/Milo data are outside this hackathon repository's scope.

Useful checks:

```bash
pnpm test
pnpm typecheck
pnpm --dir app build
```

For the shortest accurate walkthrough, open the product page, enter the workspace, show the public correction flow, then open the evidence view and trace one retained run from decision to gate.
