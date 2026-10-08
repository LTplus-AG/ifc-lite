/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bounded parsing of a model's JSON reply.
 *
 * A reply is accepted only as ONE complete JSON value: the whole text, or the
 * whole text wrapped in a single ```json fence. Nothing is extracted from
 * surrounding prose, and a truncated reply is never repaired into something
 * parseable: an incomplete answer must not become an executable one. Size,
 * nesting depth and node count are bounded before the caller validates the
 * shape, and prototype-polluting keys are refused outright.
 */

export interface JsonOutputLimits {
  /** Maximum reply length in UTF-16 code units. */
  readonly maxChars: number;
  /** Maximum nesting depth of arrays/objects (the top-level value is depth 1). */
  readonly maxDepth: number;
  /** Maximum number of values (scalars, arrays, objects) in the whole document. */
  readonly maxNodes: number;
}

export const DEFAULT_JSON_OUTPUT_LIMITS: JsonOutputLimits = { maxChars: 48_000, maxDepth: 8, maxNodes: 20_000 };

export type JsonOutputFailure = 'too-large' | 'not-json' | 'too-deep' | 'too-many-values' | 'forbidden-key' | 'truncated';

export type JsonOutput =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: JsonOutputFailure; readonly message: string };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FENCED = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/;

/**
 * Parse `text` as one bounded JSON value. `truncated` marks a reply the
 * provider stopped at its output ceiling; it is refused even when it happens
 * to parse, because the value may be a prefix of what was meant.
 */
export function parseJsonOutput(text: string, limits: JsonOutputLimits = DEFAULT_JSON_OUTPUT_LIMITS, truncated = false): JsonOutput {
  if (truncated) return { ok: false, reason: 'truncated', message: 'the reply stopped at the output ceiling' };
  if (text.length > limits.maxChars) return { ok: false, reason: 'too-large', message: `the reply exceeds ${limits.maxChars} characters` };
  const trimmed = text.trim();
  const fenced = FENCED.exec(trimmed);
  let value: unknown;
  try {
    value = JSON.parse(fenced ? fenced[1] : trimmed);
  } catch (error) {
    return { ok: false, reason: 'not-json', message: error instanceof Error ? error.message : String(error) };
  }
  // Iterative walk: no stack to exhaust, and both bounds are checked per value.
  let nodes = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (++nodes > limits.maxNodes) return { ok: false, reason: 'too-many-values', message: `the reply holds more than ${limits.maxNodes} values` };
    if (item.value === null || typeof item.value !== 'object') continue;
    if (item.depth > limits.maxDepth) return { ok: false, reason: 'too-deep', message: `the reply nests deeper than ${limits.maxDepth} levels` };
    if (Array.isArray(item.value)) {
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(item.value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) return { ok: false, reason: 'forbidden-key', message: `the reply uses the reserved key "${key}"` };
      pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return { ok: true, value };
}
