// Gym NYC operator. The model chooses the SQL and states its definition; every number in
// the body comes from running that SQL here, so an answer cannot be typed in by the model.
// Without pinned decisions it receives no definition hint. That is the honest baseline.
import { sha256 } from '../contract/hash.js';
import type { EvidenceInput, Handler, HandlerResult } from '../contract/types.js';
import { type GymReader, MAX_ROWS, type SqlResult, validateGymSql } from './gymReader.js';
import { AgentOutputError, type ModelClient, type ModelMessage, ModelTrace, type ModelResponse } from './model.js';
import { buildSystemPrompt, withTechnique } from './prompt.js';

const MAX_TURNS = 12;

const ROLE = `You are the Gym NYC operator agent. You answer an operator's question from a read-only, pseudonymized mirror of company data in Postgres schema gym.

Use describe_gym_schema to see the tables and run_sql to explore. When you are ready, call submit_answer exactly once. Do not answer in plain text.
- sql: one aggregate query whose rows are the answer. It must return a location_id column and a numeric column named for the metric, such as active_individual_members.
- definition: exactly what you counted, in one line, naming the table, the filters and the snapshot you used.
- freshness_sql: one query returning a single row with one column, data_as_of, holding when the data behind your answer was current. If locations differ, report the oldest.

Your numbers come from running these queries, so never estimate. If the data cannot answer the question, say so in the definition.`;

const TOOLS = [
  {
    name: 'describe_gym_schema',
    description: 'List the tables and columns in schema gym.',
    strict: true,
    input_schema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'run_sql',
    description: `Run one read-only SELECT or WITH statement against schema gym. Returns at most ${MAX_ROWS} rows.`,
    strict: true,
    input_schema: {
      type: 'object' as const,
      properties: { sql: { type: 'string' } },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_answer',
    description: 'Submit the final answer. The queries are executed and their results become the answer.',
    strict: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        sql: { type: 'string' },
        definition: { type: 'string' },
        freshness_sql: { type: 'string' },
      },
      required: ['sql', 'definition', 'freshness_sql'],
      additionalProperties: false,
    },
  },
];

const asNumber = (value: unknown): unknown =>
  typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : typeof value === 'bigint' ? Number(value) : value;

/** Postgres text or a Date, as an ISO-like string. */
function asOfText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Whole days between data_as_of and now. Date-only values read as UTC midnight. Null when unparseable. */
export function ageInDays(dataAsOf: string | null, now: Date): number | null {
  if (!dataAsOf) return null;
  const text = /^\d{4}-\d{2}-\d{2}$/.test(dataAsOf) ? `${dataAsOf}T00:00:00Z` : dataAsOf.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((now.getTime() - ms) / 86_400_000));
}

interface TraceEntry { sql: string; row_count?: number; error?: string; }

export function createGymOperator(deps: { model: () => ModelClient; reader: () => GymReader; now?: () => Date }): Handler {
  return async ({ task, decisions, repairNotes, technique }) => {
    const reader = deps.reader();
    const now = deps.now?.() ?? new Date();
    const trace = new ModelTrace(deps.model());
    const system = buildSystemPrompt(ROLE, decisions, repairNotes);
    const sqlTrace: TraceEntry[] = [];

    const runTraced = async (sql: string): Promise<SqlResult> => {
      const rejected = validateGymSql(sql);
      if (rejected) { sqlTrace.push({ sql, error: rejected }); throw new Error(rejected); }
      try {
        const result = await reader.query(sql);
        sqlTrace.push({ sql, row_count: result.rows.length });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sqlTrace.push({ sql, error: message });
        throw new Error(message);
      }
    };

    const finalize = async (input: { sql: string; definition: string; freshness_sql: string }): Promise<HandlerResult> => {
      const answerResult = await runTraced(input.sql);
      if (!answerResult.columns.includes('location_id') || answerResult.columns.length < 2) {
        throw new Error(`sql must return location_id and a metric column; it returned: ${answerResult.columns.join(', ')}`);
      }
      if (answerResult.truncated) throw new Error(`sql returned more than ${MAX_ROWS} rows; submit an aggregate`);
      const freshness = await runTraced(input.freshness_sql);
      if (freshness.rows.length !== 1 || !freshness.columns.includes('data_as_of')) {
        throw new Error('freshness_sql must return one row with a data_as_of column');
      }
      const dataAsOf = asOfText(freshness.rows[0]!.data_as_of);
      const dataAgeDays = ageInDays(dataAsOf, now);
      const answer = answerResult.rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === 'location_id' ? value : asNumber(value)])));
      const metricTotals = Object.fromEntries(answerResult.columns.filter((c) => c !== 'location_id').flatMap((column) => {
        const values = answer.map((row) => row[column]);
        // No rows means unknown, not zero: a total is only reported when there is something to add up.
        return values.length > 0 && values.every((v) => typeof v === 'number') ? [[column, (values as number[]).reduce((sum, v) => sum + v, 0)]] : [];
      }));
      const sqlPayload = { sql: input.sql, columns: answerResult.columns, row_count: answer.length, rows: answer, metric_totals: metricTotals };
      const freshnessPayload = { sql: input.freshness_sql, data_as_of: dataAsOf, data_age_days: dataAgeDays, measured_at: now.toISOString() };
      const queriesPayload = { queries: sqlTrace };
      const evidence: EvidenceInput[] = [
        { kind: 'sql_result', sha256: sha256(sqlPayload), payload: sqlPayload },
        { kind: 'data_freshness', sha256: sha256(freshnessPayload), payload: freshnessPayload },
        { kind: 'sql_trace', sha256: sha256(queriesPayload), payload: queriesPayload },
        trace.evidence(system, decisions.map((d) => d.id)),
      ];
      return {
        body: { answer, definition: input.definition, data_as_of: dataAsOf, data_age_days: dataAgeDays, sql: input.sql },
        evidence,
      };
    };

    const messages: ModelMessage[] = [{ role: 'user', content: withTechnique(task, technique) }];
    let nudged = false;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const response: ModelResponse = await trace.create({ system, messages, tools: TOOLS, output_config: { effort: 'medium' } });
      messages.push({ role: 'assistant', content: response.content });
      const calls = response.content.flatMap((block) => (block.type === 'tool_use' ? [block] : []));
      if (calls.length === 0) {
        if (nudged) throw new AgentOutputError('Gym operator stopped without calling submit_answer');
        nudged = true;
        messages.push({ role: 'user', content: 'Call submit_answer with your queries. A plain-text answer is not accepted.' });
        continue;
      }
      const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
      for (const call of calls) {
        try {
          const input = call.input as { sql: string; definition: string; freshness_sql: string };
          if (call.name === 'submit_answer') return await finalize(input);
          const output = call.name === 'describe_gym_schema' ? await reader.describeSchema() : await runTraced(input.sql);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(output, (_key, value) => (typeof value === 'bigint' ? Number(value) : value)) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: message, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    throw new AgentOutputError(`Gym operator did not submit an answer within ${MAX_TURNS} turns`);
  };
}
