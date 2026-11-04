import { sha256 } from '../contract/hash';
import type { CheckSpec, EvaluationBinding, EvaluationResult, Verdict } from '../contract/types';

export const EVALUATOR_VERSION = '1';
export const EVALUATION_RECEIPT_KIND = 'behavioral_evaluation';

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Every result carries evidence tied to the binding, so `requires_evidence` can always be met honestly. */
export function makeResult(
  input: { binding: EvaluationBinding; check: CheckSpec },
  evaluator: string,
  verdict: Verdict,
  reason: string,
  payload: Record<string, unknown> = {},
): EvaluationResult {
  const body = {
    check_id: input.check.check_id,
    evaluator,
    evaluator_version: EVALUATOR_VERSION,
    verdict,
    reason,
    output_sha256: input.binding.output_sha256,
    contract_sha256: input.binding.contract_sha256,
    ...payload,
  };
  return {
    check_id: input.check.check_id,
    verdict,
    reason,
    evaluator,
    evaluator_version: EVALUATOR_VERSION,
    // Kind is excluded when loading source evidence, so a receipt can never count as evidence for itself.
    evidence: { kind: EVALUATION_RECEIPT_KIND, sha256: sha256(body), payload: body },
  };
}

/** Collapses the tricks that defeat a phrase match: curly quotes, zero-width characters, casing, line breaks. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/[‘’ʼ＇]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/** Every string in a JSON value, for checking that a quote really appears in it. */
export function textLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textLeaves);
  if (isRecord(value)) return Object.values(value).flatMap(textLeaves);
  return [];
}

/** Calendar date in New York, the business timezone of the source. Date-only input is returned as is. */
export function toNyDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}
