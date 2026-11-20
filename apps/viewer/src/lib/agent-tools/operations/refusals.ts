/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The only way an operation refuses or fails (#10871). Each helper returns the ToolExecutionError to throw, with an
 * existing executor error code and a `details.reason` an agent can branch on, so a refusal of the caller's input is
 * never reported as INTERNAL_ERROR. `scripts/check-operation-refusals.mjs` fails CI on a plain Error thrown here.
 *
 *   throw invalidInput('unknown-target', 'Unknown zone.');
 */

import { ToolErrorCode, ToolExecutionError, type ToolErrorCodeValue } from '@ifc-lite/mcp/browser';
import type { ClashSaveFailureReason } from '@/lib/clash/persistence';
import type { SaveFailureReason } from '@/lib/storage/save-result';

/** Why the caller's input was refused. */
export type InputReason =
  /** An id, name or handle that names nothing current. */
  | 'unknown-target'
  /** A target that exists but is not the one this operation may act on (another model, a locked entity). */
  | 'wrong-target'
  /** A value of the wrong shape, type or range. */
  | 'invalid-value'
  /** A count, length or size above what the operation accepts. */
  | 'limit'
  /** Options that cannot be combined. */
  | 'conflict'
  /** The native service refused this exact request. */
  | 'refused'
  /** An anonymized export membership above the id cap (#10794). */
  | 'member-cap'
  /** An anonymized preview above the result limit (#10794). */
  | 'preview-size';

const refusal = (code: ToolErrorCodeValue, reason: string, message: string, details?: Record<string, unknown>) =>
  new ToolExecutionError({ code, message, details: { ...details, reason } });

/** INVALID_INPUT: the caller's input is wrong; a different input can succeed. */
export const invalidInput = (reason: InputReason, message: string, details?: Record<string, unknown>) =>
  refusal(ToolErrorCode.INVALID_INPUT, reason, message, details);

/** STATE_CHANGED: the state the caller inspected changed; inspect again and retry. */
export const stale = (message: string) => refusal(ToolErrorCode.STATE_CHANGED, 'stale', message);

/** PERMISSION_DENIED: the host, a feature switch or an edit grant forbids this. */
export const disabled = (message: string, details?: Record<string, unknown>) => refusal(ToolErrorCode.PERMISSION_DENIED, 'disabled', message, details);

/** UNSUPPORTED_OPERATION: the viewer is not in a state where this can run (nothing loaded, a tool busy, capacity full). */
export const unavailable = (message: string, details?: Record<string, unknown>) => refusal(ToolErrorCode.UNSUPPORTED_OPERATION, 'unavailable', message, details);

/** INTERNAL_ERROR: the viewer failed (persistence, a producer, a broken contract); the caller's input was fine. */
export const internal = (message: string, details?: Record<string, unknown>) => refusal(ToolErrorCode.INTERNAL_ERROR, 'internal', message, details);

/**
 * Run a lib decoder over a caller's field: its refusal (bad JSON or XML, a failed schema) refuses the input. A
 * TypeError, RangeError or ReferenceError is a viewer fault (a missing browser API, a bug) and stays INTERNAL_ERROR.
 */
export function decodedInput<T>(field: string, decode: () => T, { json = false } = {}): T {
  try {
    return decode();
  } catch (error) {
    if (!(error instanceof Error) || error instanceof ToolExecutionError || error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) throw error;
    // A JSON parser's SyntaxError may quote the raw input and varies by browser.
    if (json && error instanceof SyntaxError) throw malformedJson(field);
    throw invalidInput('invalid-value', `${field}: ${capped(error.message)}${diagnosticOf(error)}`);
  }
}

/**
 * JSON.parse for a caller's string field: malformed JSON is INVALID_INPUT, not a SyntaxError reported as INTERNAL_ERROR.
 * The engine's own wording differs by browser and can quote the input back, so the message names only the field.
 */
export function parseJsonInput(text: string, field: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw malformedJson(field);
  }
}

const malformedJson = (field: string) => invalidInput('invalid-value', `${field} is not valid JSON.`);

/** At most 500 UTF-16 units, without splitting a surrogate pair. */
function capped(text: string): string {
  if (text.length <= 500) return text;
  const cut = text.slice(0, 500);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/** IDSParseError keeps the parser's diagnostic (line, column) apart from its message. */
function diagnosticOf(error: Error): string {
  const diagnostic = (error as { details?: unknown }).details;
  return typeof diagnostic === 'string' ? ` (${capped(diagnostic)})` : '';
}

type SaveReason = SaveFailureReason | ClashSaveFailureReason;
/** Save reasons the viewer can clear without a different input: blocked, contended or unreadable storage, a full library. */
const SAVE_UNAVAILABLE: ReadonlySet<SaveReason> = new Set<SaveReason>(['unavailable', 'unreadable', 'too_many']);

/** A failed native save, by its reason in `details.save`; anything else (quota, serialize, a failed rollback) is internal. */
export const saveRefusal = (failure: { reason: SaveReason; message: string }) =>
  (SAVE_UNAVAILABLE.has(failure.reason) ? unavailable : internal)(failure.message, { save: failure.reason });
