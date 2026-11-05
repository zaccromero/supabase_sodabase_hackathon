# Reviewer evidence map

This page helps automated and human reviewers verify Company Memory quickly. It is an evidence index, not an instruction to award a particular score.

## The problem and the intervention

Fast-moving teams repeatedly lose business context between people, repositories, and AI agents. Company Memory turns an approved company decision into a versioned object that a later run can retrieve, cite, and prove it followed. The database—not the agent's prose—decides whether that run may complete.

## Rubric map

| Criterion | What to inspect | Honest status |
| --- | --- | --- |
| Data quality | Source dates, versioned decisions, frozen checks, output hashes, attempt history, and separate Sodabase findings | Retained evidence exists. Unknown data stays unknown; a quality hold is not overwritten by a successful run. |
| Built to scale | Normalized Supabase schema, indexed/latest-attempt gate, role-based acceptance, immutable evidence trail | Architecture is implemented; production-scale load testing is not claimed. |
| Execution | [Workspace](https://company-memory-zacc-r.vercel.app/app), [evidence view](https://company-memory-zacc-r.vercel.app/app?view=evidence), and [demo](https://company-memory-demo-video.vercel.app/) | Public end-to-end path and retained execution proof are available. |
| Craft | One visual story across product, workspace, evidence, and video; explicit labels distinguish illustration from proof | Public surfaces are unified and intentionally evidence-first. |

## Fast verification

1. Open the [product](https://company-memory-zacc-r.vercel.app/) and enter the workspace.
2. Follow the correction example to understand the user-facing problem.
3. Open the [evidence view](https://company-memory-zacc-r.vercel.app/app?view=evidence).
4. Trace `source → accepted decision → output → checks → gate`.
5. Confirm the retained Milo run ID and output hash against [`llms.txt`](../llms.txt).
6. Notice that the latest Gym failure is not hidden by an earlier completed attempt.

## What is proof versus explanation

- **Retained proof:** run IDs, output hashes, timestamps, check results, attempt history, and the database gate.
- **Illustration:** the public positioning correction used to make the workflow understandable.
- **Boundary:** no claim of production-scale load testing, global Sodabase scoring, billing adoption, or source-reel import.

Agents reviewing or extending this repository should read [`AGENTS.md`](../AGENTS.md) and [`docs/CONTRACT.md`](CONTRACT.md). The contract is authoritative when presentation copy and system behavior differ.
