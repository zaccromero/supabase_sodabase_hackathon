import { createHash } from 'node:crypto';
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const sha256 = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : canonicalJson(v)).digest('hex');
