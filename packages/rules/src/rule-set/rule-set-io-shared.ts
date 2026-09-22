/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared plumbing for the `rule-set-io-*.ts` split (#5138): the exception
 * type `parseRuleSetFile` catches to turn any failure into `{ ok: false,
 * error }`, small JSON-shape guards, and the one-warning-per-parse budget
 * for unknown optional fields (plan §3 forward-compat posture). Split out
 * of `rule-set-io.ts` purely to stay under the ~400-line module cap — the
 * parse logic is one recursive-descent pass over one file format, not
 * several independent modules.
 */

/** Thrown by every `parseX` helper on a validation failure; caught once at
 *  the top of `parseRuleSetFile` and turned into `{ ok: false, error }`.
 *  Never escapes this package. */
export class RuleSetError extends Error {}

export function fail(message: string): never {
  throw new RuleSetError(message);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function unknownKeysOf(obj: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !known.includes(k));
}

/** Whether the one-warning-per-parse budget has been spent. Reset by
 *  `resetWarnBudget()` at the top of every `parseRuleSetFile` call — this
 *  module has exactly one entry point that resets it, and node:test/the
 *  browser both run it single-threaded, so a concurrent parse never
 *  interleaves with another's budget. */
let warnedThisParse = false;

export function resetWarnBudget(): void {
  warnedThisParse = false;
}

/** Warn once, for the whole parse, that unknown OPTIONAL fields were
 *  dropped — never for an unknown top-level key, which is a hard reject
 *  (`fail`), not a warning. */
export function warnUnknownFields(context: string, unknown: string[]): void {
  if (unknown.length === 0 || warnedThisParse) return;
  warnedThisParse = true;
  console.warn(`[rule-set] ${context}: ignoring unknown field(s) ${unknown.join(', ')}`);
}
