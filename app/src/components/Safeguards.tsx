// What the database itself refuses, from supabase/migrations. Each line names a rule that
// exists in the schema, not a policy. tests/gate.test.ts proves the core ones.
const RULES: Array<[string, string]> = [
  ['Agents cannot grade themselves', 'The worker role can write outputs and evidence. It cannot write evaluations, change a run, call the gate or accept a decision.'],
  ['Only the founder accepts', 'A trigger refuses acceptance from any agent or service role.'],
  ['Checks are frozen first', 'No attempt can start until the contract is frozen, and a frozen contract cannot change.'],
  ['Evaluations are bound', 'Each one names its attempt, output hash and contract hash. A mismatch is rejected.'],
  ['Completion goes through the gate', 'A run cannot be marked completed while a required check is missing. Only the latest attempt counts, so a repair voids earlier passes.'],
  ['The record is append-only', 'Outputs, evidence, evaluations, approvals and gate decisions cannot be edited or deleted.'],
  ['Verification needs a real run', 'A finding is verified only by a completed run that pinned the correction.'],
  ['Row level security is on', 'Enabled on the memory tables, which the public API does not expose.'],
];

export function Safeguards() {
  return (
    <section className="safeguards" aria-labelledby="q-safeguards">
      <header className="section-head"><h2 id="q-safeguards" className="question">What stops an agent from faking this?</h2></header>
      <p className="section-note">Enforced by the database. Tracing shows what happened. Evaluators detect behavioral drift. Sodabase checks data quality.</p>
      <ul className="safeguard-list">
        {RULES.map(([title, detail]) => (
          <li key={title}>
            <p className="safeguard-title">{title}</p>
            <p className="eval-reason">{detail}</p>
          </li>
        ))}
      </ul>
      <p className="flag-line next-extension">
        <span className="flag">next extension, not built</span>
        Improving skills and MCP tools the same way: propose a diff, approve it, apply it within scope, verify with a fresh run. Nothing changes itself.
      </p>
    </section>
  );
}
