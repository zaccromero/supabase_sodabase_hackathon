# Hermes OAuth integration — owner-selected transport

No Anthropic API key. No Claude app control, private histories, exported OAuth credentials, guard bypass, global configuration or shared runtime restart. The existing integration owner executes the actual run once; this lane has performed only one non-sensitive transport smoke.

Copy these owned files into the existing application:

- `src/governance-demo/hermes-transport.ts`
- `src/governance-demo/hermes_oauth.py`
- `src/governance-demo/runner-bridge.ts` if adopting the advisory stored-run adapter

The TypeScript model interface imports existing `src/agents/model.ts` as types only; it does not call the Anthropic SDK. Python defaults to installed `/Users/zaccromero/.drako/hermes/current/.venv/bin/python`, imports existing Hermes runtime classes, and reuses its existing `openai-codex` / `codex_app_server` route. No server install or native app is needed. The actual served model is recorded from `thread/start`, separately from requested model.

## Exact generation and critic ports

```ts
import { createHandlers } from './src/agents/index';
import { createRegistry, checksFor, guarded } from './src/evaluators/index';
import { createCriticEvaluator } from './src/evaluators/critic';
import { withHermesGeneration, withHermesCritic } from './src/governance-demo/hermes-transport';

const handler = withHermesGeneration(client => createHandlers({
  model: () => client,
  slidePacketPath: approvedSanitizedSlidePacketPath,
}).milo_pitch);
const critic = withHermesCritic(transport => guarded(
  createCriticEvaluator({transport, criticTimeoutMs: 120_000}),
  'critic.meaning',
));
const binding = {
  handler,
  checks: decisions => checksFor('milo_pitch', decisions),
  evaluators: {...createRegistry(), 'critic.meaning': critic},
};
// The existing integration owner supplies its Db and runs runAgent exactly once.
// No automatic approval, check mutation, repair beyond the runner budget or fallback.
```

This port supports Milo's text/JSON generation and independent critic. It explicitly refuses application tool requests; it does not silently replace the Gym handler's tool loop. All original three-profile/reel requirements remain open with their existing owners.

Python consumes one bounded stdin JSON `{system,user}` with `--execute`, returns `{ok,text,receipt}`. Default/`--doctor` resolves route metadata and makes zero model calls. `--smoke` is the fixed acknowledgment test already run; **do not repeat it** without changed evidence. The caller can supply `python`/`script` paths and `onReceipt`, but cannot pass credentials or widen the scope through the request.

## Isolation and proof

The existing Hermes `NativeNoToolsScope` binds a fresh `CodexAppServerSession`: filesystem root denied except minimal runtime, tool network disabled, native tools/MCP/apps/plugins/delegation disabled through the existing scope, no initial context/history, native memory use/generation off and thread memory mode disabled. Scope application is verified by the existing Hermes session implementation before the turn. No `-z`, `--yolo`, approval response, permission expansion or custom token extraction.

The transport requires a completed single model turn, zero tool iterations, actual served model, `openai-codex` provider, no guard bypass/export and confirmed memory/no-tools receipts. Failed/cancelled/malformed outcomes are errors or uncertainty, with no retry/fallback. SIGTERM cleanup closes the child session. Each semantic evaluator call and handler attempt has its own receipt collection, so parallel checks cannot borrow evidence from another output.

### Persisted evidence contract

`withHermesGeneration(factory, options) -> Handler`: appends **one evidence item per actual call**, kind `hermes_transport`, payload `{purpose:'generation',receipt}`, canonical SHA-256. A handler returning an authored candidate without a received Hermes receipt throws. Existing `model_run` evidence keeps the declared legacy agent label as `declared_agent_model`; `requested_model` is corrected from actual Hermes receipt and labeled `requested_model_source:'hermes_transport'`. Actual served model and tokens come from the response; unreported token values are not claimed as measured.

`withHermesCritic(factory, options) -> Evaluator`: preserves the native semantic judgment; returns evidence kind `hermes_critic_evaluation`, payload `{...originalSemanticPayload,transport:'hermes_oauth',model:actualServedModelOrNull,requested_model:actualOrNull,purpose:'critic',hermes_receipts:[...]}`, canonical SHA-256. A purported pass without an actual received receipt becomes uncertain. The runner writes this evidence/evaluation under its existing current output/hash/contract binding and evaluator role; the wrapper never writes to DB or approves.

Mandatory acceptance fields inside each successful receipt:

- `provider:'openai-codex'`, actual `served_model`, `requested_model`, observed `model_provider`
- actual `thread_id`, `turn_id`, `model_turns:1`, `tool_iterations:0`
- `guard_bypass:false`, `credential_exported:false`
- `isolation:{use_memories:false,generate_memories:false,thread_memory_mode:'disabled'}`
- `no_tools_scope:{tool_policy:'none',max_authorized_actions:0,...}`
- request input hash and timestamps

Generation evidence and critic evidence must point to the same actual latest output through the canonical DB foreign keys. A smoke's receipt cannot be reused as generation/critic evidence. An actual new run must retrieve/pin the exact existing accepted Milo v1 decision; no statement change or new approval is implied.

## Existing receipts

`hermes-doctor.json`: metadata resolved, zero model calls. `hermes-smoke.json`: one live non-sensitive acknowledgment at 17:05 EST; actual `gpt-6.1-sol`, OAuth route, native memory disabled, zero tool actions. This is **transport proof only**, not fresh Milo generation, critic judgment, database completion or hosted proof.

`hermes-port-tests.txt`: eight synthetic TypeScript boundary/receipt-mapping tests PASS. `hermes-python-tests.txt`: four synthetic wrapper tests PASS. `hermes-typecheck.txt`: strict typecheck PASS against actual published model interface. Local reproduction resolves SDK types from actual installed package via the isolated tsconfig's explicit .d.mts mapping; do not copy that local configuration into the application.

The actual prior app run reported through the governor used `claude_cli` and awaited founder approval; it remains separate and cannot certify Hermes. Live Sodabase token is now stored; real event findings are undetermined while tables/scans are absent. Hosted installation and correct dataset binding remain separate gates. Work-ready17:50 EST, submission18:30 EST November4,2026.
