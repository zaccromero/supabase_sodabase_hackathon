/**
 * Provider tools never return rows, and this keeps it that way for anything we store: row-shaped keys are dropped and
 * strings are scrubbed before a response reaches the database or a committed receipt. Applied to every response.
 */
const ROW_KEYS = new Set(['rows', 'row', 'records', 'record', 'sample', 'samples', 'sample_rows', 'example', 'examples', 'example_rows', 'values', 'top_values', 'allowed_values', 'query', 'sql', 'view_query', 'sample_query', 'sql_query']);
const MAX_STRING = 2000;
const MAX_DEPTH = 12;
const MAX_ITEMS = 200;

export function scrubText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code removed]')
    .replace(/\bselect\b[\s\S]{0,800}?\bfrom\b[^\n]*/gi, '[query removed]')
    .replace(/\bsb_pat_[\w-]+/g, '[token removed]')
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, '$1?[query string removed]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [token removed]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email removed]')
    .replace(/(?<![\w-])\+?\d[\d ().-]{8,}\d(?![\w-])/g, (m) => (/^\d{4}-\d{2}-\d{2}/.test(m) ? m : '[phone removed]'))
    .slice(0, MAX_STRING);
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[too deep]';
  if (typeof value === 'string') {
    // Live responses wrap their data in a JSON string, so row-shaped keys inside it have to be seen too.
    if (/^\s*[{[]/.test(value)) {
      try { return sanitize(JSON.parse(value), depth + 1); } catch { /* plain text */ }
    }
    return scrubText(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // A numeric "rows" is a count, which is what we want. Anything else under these keys could be row data.
    if (ROW_KEYS.has(k.toLowerCase()) && typeof v !== 'number') continue;
    out[k] = sanitize(v, depth + 1);
  }
  return out;
}
