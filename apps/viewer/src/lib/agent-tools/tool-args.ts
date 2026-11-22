/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Argument checks and the commands-and-edits grant, shared by the viewer-native
 * agent tools. Only an absent key takes a default: an explicit null is invalid
 * like any other wrong value (the discovery hardening tests pin this).
 */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { assertDispatchActive } from './cancellation';
import type { ToolCallContext } from './types';
import { invalidInput } from './operations/refusals';

export type ToolErrorCodeValue = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

export function fail(code: ToolErrorCodeValue, message: string, hint?: string): never {
  throw new ToolExecutionError({ code, message, ...(hint ? { hint } : {}) });
}

/** Caller input is wrong: the typed refusal shape of operations/refusals.ts, so agents can branch on details.reason. */
export function invalid(message: string): never {
  throw invalidInput('invalid-value', message);
}

/** Refuse unless the tab user allowed palette commands and edits. Call again after every await before acting. */
export function assertGranted(ctx: ToolCallContext): void {
  assertDispatchActive(ctx.signal);
  if (!ctx.canEdit?.()) fail(ToolErrorCode.READ_ONLY,
    'The tab has not allowed palette commands and edits. The user must enable them in the local agent connection panel.');
}

export function keys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key));
  if (unknown.length) invalid(`Unknown argument ${unknown.join(', ')}. Allowed: ${allowed.join(', ') || 'none'}.`);
}

/** A string of at most `max` characters; blank only with `allowBlank` (a search query that lists everything). */
export function boundedString(args: Record<string, unknown>, key: string, max: number, allowBlank = false): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || (!allowBlank && !value.trim()) || value.length > max) {
    invalid(`${key} must be a ${allowBlank ? '' : 'nonempty '}string of at most ${max} characters.`);
  }
  return value;
}

export function integer(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${key} must be an integer from ${min} to ${max}.`);
  return value;
}

/** One of `choices`, or `fallback` when absent. */
export function oneOf<T extends string>(args: Record<string, unknown>, key: string, choices: readonly T[], fallback?: T): T | undefined {
  const value = args[key] === undefined ? fallback : args[key];
  if (value !== undefined && !choices.includes(value as T)) invalid(`${key} must be one of: ${choices.join(', ')}.`);
  return value as T | undefined;
}
