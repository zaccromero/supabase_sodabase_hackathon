/**
 * Static reading of the SQL an agent reports. Comments are removed and string contents are masked before any
 * keyword is matched, so a comment or a string literal cannot satisfy a structural requirement.
 * Fail-closed heuristics, not a SQL parser: shapes it cannot vouch for come back as `uncertain` flags.
 */
const MASK = '\u0001';

export interface PreparedSql { code: string; masked: string; }

export function prepareSql(sql: string): PreparedSql {
  let code = '';
  let masked = '';
  let i = 0;
  const push = (c: string, m: string) => { code += c; masked += m; };
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      push(' ', ' ');
      continue;
    }
    if (two === '/*') {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === '/*') { depth++; i += 2; }
        else if (sql.slice(i, i + 2) === '*/') { depth--; i += 2; }
        else i++;
      }
      push(' ', ' ');
      continue;
    }
    const ch = sql[i]!;
    if (ch === "'") {
      push("'", "'");
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { push("''", MASK + MASK); i += 2; continue; }
        if (sql[i] === "'") break;
        push(sql[i]!, MASK);
        i++;
      }
      if (i < sql.length) { push("'", "'"); i++; }
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      const body = sql.slice(i, stop);
      push(body, MASK.repeat(body.length));
      i = stop;
      continue;
    }
    push(ch, ch);
    i++;
  }
  return { code, masked };
}

const ident = (name: string) => `(?:"?[A-Za-z_][\\w$]*"?\\.)?"?${name}"?(?![\\w$])`;

export const readsTable = (masked: string, table: string) =>
  new RegExp(`\\b(?:from|join)\\s+(?:only\\s+)?(?:lateral\\s+)?${ident(table)}`, 'i').test(masked)
  || new RegExp(`\\bfrom\\s+[^;()]*?,\\s*${ident(table)}`, 'i').test(masked);

export interface Comparison { operator: string; literals: string[]; }

/** Every comparison of `column` to string literals, with literal values read from the unmasked text. */
export function comparisons(sql: PreparedSql, column: string): Comparison[] {
  const re = new RegExp(`${ident(column)}\\s*(=|<>|!=|not\\s+in|in)\\s*(\\([^)]*\\)|'[^']*')`, 'gi');
  const out: Comparison[] = [];
  for (const m of sql.masked.matchAll(re)) {
    const start = m.index + m[0].length - m[2]!.length;
    const raw = sql.code.slice(start, start + m[2]!.length);
    const literals = [...raw.matchAll(/'((?:[^']|'')*)'/g)].map((l) => l[1]!.replace(/''/g, "'"));
    out.push({ operator: m[1]!.toLowerCase().replace(/\s+/g, ' '), literals });
  }
  return out;
}

export const mentionsColumn = (masked: string, column: string) => new RegExp(`(?<![\\w$])${column}(?![\\w$])`, 'i').test(masked);

export interface DefinitionAnalysis {
  readsProjection: boolean;
  negatedProjection: boolean;
  canonicalClass: boolean;
  otherClassComparison: boolean;
  readsRuns: boolean;
  completeStatus: boolean;
  selectsLatest: boolean;
  usesChurnedAt: boolean;
  hasOr: boolean;
  hasSetOperation: boolean;
}

export function analyzeDefinitionSql(raw: string, opts: { table: string; runsTable: string; bridgeClass: string }): DefinitionAnalysis {
  const sql = prepareSql(raw);
  const { masked } = sql;
  const classes = comparisons(sql, 'bridge_class');
  const isCanonical = (c: Comparison) => (c.operator === '=' || c.operator === 'in') && c.literals.length === 1 && c.literals[0] === opts.bridgeClass;
  const statuses = comparisons(sql, 'status');
  const latestColumn = '(?:started_at|finished_at|report_as_of)';
  const runsRef = ident(opts.runsTable);
  return {
    readsProjection: readsTable(masked, opts.table),
    negatedProjection: new RegExp(`\\bnot\\s+exists\\s*\\(\\s*select\\b[^)]*?\\bfrom\\s+${ident(opts.table)}`, 'i').test(masked),
    canonicalClass: classes.some(isCanonical),
    otherClassComparison: classes.some((c) => !isCanonical(c)),
    readsRuns: readsTable(masked, opts.runsTable),
    completeStatus: statuses.some((c) => (c.operator === '=' || c.operator === 'in') && c.literals.length === 1 && c.literals[0] === 'complete'),
    selectsLatest:
      new RegExp(`\\border\\s+by\\b[^;]*?${latestColumn}\\b[^;]*?\\bdesc\\b`, 'i').test(masked)
      || new RegExp(`\\bmax\\s*\\(\\s*(?:"?\\w+"?\\.)?"?${latestColumn}`, 'i').test(masked)
      || /\bdistinct\s+on\b/i.test(masked)
      || /\brow_number\s*\(/i.test(masked)
      // The form member-contract.ts itself uses: the projection table holds only the current projection.
      || new RegExp(`(?<!\\bnot\\s)\\bexists\\s*\\(\\s*select\\b[^)]*?\\bfrom\\s+${runsRef}`, 'i').test(masked),
    usesChurnedAt: mentionsColumn(masked, 'churned_at'),
    hasOr: /\bor\b/i.test(masked),
    hasSetOperation: /\b(?:union|intersect|except)\b/i.test(masked),
  };
}
