/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a script_run script hands back, on the host side: decoding the tagged
 * string the in-sandbox wrapper (script-wrapper.ts) produces, and shaping
 * captured console output.
 */

import type { LogEntry } from '@ifc-lite/sandbox';
import { describeThrown } from '../errors.js';

/** The entry the sandbox's own console capture appends when it drops output. */
const SANDBOX_LOG_TRUNCATED = '[log output truncated: limit reached]';
/** Caps on what one call returns to the client (the sandbox caps capture at 1000 entries / 4 MB). */
export const MAX_VALUE_CHARS = 256 * 1024;
export const VALUE_PREVIEW_CHARS = 2_000;
export const MAX_MESSAGE_CHARS = 4_000;
const MAX_LOG_LINES = 200;
export const MAX_LOG_CHARS = 64 * 1024;

type LogLine = { level: string; text: string };

/** A message cut to MAX_MESSAGE_CHARS, marked when the cut removed text. */
export function clipMessage(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${clipUtf16(text, MAX_MESSAGE_CHARS)} [truncated]` : text;
}

/** `text.slice(0, max)` that never ends on the first half of a surrogate pair. */
function clipUtf16(text: string, max: number): string {
  const end = max < text.length && /[\uD800-\uDBFF]/.test(text[max - 1] ?? '') ? max - 1 : max;
  return text.slice(0, end);
}

/** The wrapper already hands the bridge strings; this covers any capture that bypassed it. */
function renderLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch (err) {
    return `[unserialisable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

export function shapeLogs(entries: readonly LogEntry[], clippedLogMarker: string): { logs: LogLine[]; truncated: boolean } {
  const logs: LogLine[] = [];
  let chars = 0;
  let truncated = false;
  for (const [index, entry] of entries.entries()) {
    if (logs.length >= MAX_LOG_LINES) return { logs, truncated: true };
    // The sandbox appends its marker as the final warn entry and then stops
    // capturing; the same text logged anywhere else is just a log. A script that
    // logs the exact marker as its last line only mislabels its own logs.
    const isSandboxMarker = index === entries.length - 1 && entry.level === 'warn'
      && entry.args.length === 1 && entry.args[0] === SANDBOX_LOG_TRUNCATED;
    if (isSandboxMarker) return { logs, truncated: true };
    if (entry.level === 'warn' && entry.args.length === 1 && entry.args[0] === clippedLogMarker) {
      truncated = true;
      continue;
    }
    const text = entry.args.map(renderLogArg).join(' ');
    if (chars + text.length > MAX_LOG_CHARS) {
      // Clip the entry that crosses the budget rather than dropping it, so
      // one huge log line does not hide everything before the cut.
      const clipped = clipUtf16(text, MAX_LOG_CHARS - chars);
      if (clipped.length > 0) logs.push({ level: entry.level, text: clipped });
      return { logs, truncated: true };
    }
    chars += text.length;
    logs.push({ level: entry.level, text });
  }
  return { logs, truncated };
}

type Outcome =
  | { value: unknown; value_truncated: false }
  | { value: null; value_truncated: true; value_preview: string }
  | { error: string; quickjs?: boolean };

/** Decode the wrapper's tagged string (a returned promise dumps as `{ type, value }`). */
export function readEnvelope(dumped: unknown): Outcome {
  const state = dumped as { type?: string; value?: unknown };
  if (state?.type === 'pending') return { error: 'The script returned a promise that never settled: nothing resolved it (for example new Promise(() => {})), or the job settling it aborted, for example on exhausted memory. There are no timers.' };
  const envelope = state?.type === 'fulfilled' ? state.value : dumped;
  if (typeof envelope !== 'string') return { error: 'The script produced no result.' };
  // The wrapper bounds these; the host re-checks so a script that subverted
  // it still cannot pass an unbounded value or message on. Messages keep one
  // unit past the cap for clipUtf16 and are clipped here, before any prefix.
  const body = envelope.slice(1, envelope[0] === 'J' ? undefined : MAX_MESSAGE_CHARS + 2);
  switch (envelope[0]) {
    case 'J':
      if (body.length <= MAX_VALUE_CHARS) {
        try {
          return { value: JSON.parse(body) as unknown, value_truncated: false };
        } catch (err) {
          // Only reachable if a script subverted the wrapper.
          return { error: `The script produced an unreadable result: ${describeThrown(err)}` };
        }
      }
    // The wrapper cuts one unit past the preview so this clip can back off a
    // split surrogate pair. An over-cap J body is a preview like P.
    // falls through
    case 'P': return { value: null, value_truncated: true, value_preview: clipUtf16(body, VALUE_PREVIEW_CHARS) };
    // A QuickJS out-of-memory while serialising arrives as 'Q', not here.
    case 'U': return { error: `The script's value is not JSON-serialisable: ${clipMessage(body)}` };
    case 'T': return { error: clipMessage(body) };
    // Tagged by the wrapper only for QuickJS's own InternalError (out of memory, stack overflow).
    case 'Q': return { error: clipMessage(body), quickjs: true };
    default: return { error: 'The script produced no result.' };
  }
}
