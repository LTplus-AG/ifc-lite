/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a script_run script hands back: the in-sandbox wrapper that settles
 * and serialises its result into a bounded tagged string, the host decoding
 * of that string, and the shaping of captured console output.
 */

import type { LogEntry } from '@ifc-lite/sandbox';
import { describeThrown } from '../errors.js';

/** The entry the sandbox's own console capture appends when it drops output. */
const SANDBOX_LOG_TRUNCATED = '[log output truncated: limit reached]';
/** Caps on what one call returns to the client (the sandbox caps capture at 1000 entries / 4 MB). */
export const MAX_VALUE_CHARS = 256 * 1024;
const VALUE_PREVIEW_CHARS = 2_000;
const MAX_MESSAGE_CHARS = 4_000;
/** Deepest returned value the wrapper will serialise; ~3000 levels overflow the host stack. */
const MAX_VALUE_DEPTH = 1_000;
/** Properties the depth walk visits before calling the value too large; any value past it is over MAX_VALUE_CHARS anyway. */
const MAX_VALUE_NODES = MAX_VALUE_CHARS;
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 64 * 1024;

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

function renderLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch (err) {
    return `[unserialisable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

export function shapeLogs(entries: readonly LogEntry[]): { logs: LogLine[]; truncated: boolean } {
  const logs: LogLine[] = [];
  let chars = 0;
  for (const [index, entry] of entries.entries()) {
    if (logs.length >= MAX_LOG_LINES) return { logs, truncated: true };
    // The sandbox appends its marker as the final warn entry and then stops
    // capturing; the same text logged by the script anywhere else is just a log.
    const isSandboxMarker = index === entries.length - 1 && entry.level === 'warn'
      && entry.args.length === 1 && entry.args[0] === SANDBOX_LOG_TRUNCATED;
    if (isSandboxMarker) return { logs, truncated: true };
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
  return { logs, truncated: false };
}

/**
 * The script runs inside a function that settles a returned promise and
 * hands back one envelope: `{ json }` (the value, serialised inside the
 * sandbox), `{ threw }` (anything the script threw or rejected with) or
 * `{ unserialisable }`. Catching inside the sandbox means a `ScriptError`
 * reaching the host is only ever an interrupt or a sandbox fault (QuickJS
 * interrupts are uncatchable). A direct eval gives the script its own
 * variable environment and keeps its completion value (the flow script node
 * does the same). Plain JS: the TypeScript strip needs esbuild-wasm, which
 * does not initialise under Node. The sandbox has no eval option that
 * settles and serialises the result itself; this wrapper stands in for one.
 */
export function wrapScript(code: string): string {
  // The script's function is created in the global scope, outside the
  // helpers' closure, and the Promise/JSON primitives are bound before it
  // runs, so a script that declares or assigns `env`, or reassigns
  // `Promise`, cannot reach what the wrapper relies on. The envelope is a
  // tagged primitive string, which no prototype or toJSON patch can reshape
  // on its way through vm.dump, and an oversized value or message is cut down
  // inside the sandbox so only a bounded string crosses to the host.
  return `(function (run, P, isInstance, then, apply, slice, Str, stringify, keys, max, preview, maxMessage, maxDepth, maxNodes) {
  function msg(e) {
    // message is read once and coerced inside the try, so a getter or
    // toString cannot throw past the wrapper and pose as a sandbox error.
    // The error type is kept (TypeError: ..., not just the message), and an
    // empty message falls back to the thrown value's string form.
    var m;
    try {
      var x = e && e.message, n = e && e.name;
      m = typeof x !== 'string' || x === '' ? Str(e)
        : typeof n === 'string' && n !== '' && n !== 'Error' ? n + ': ' + x : x;
    } catch (c) {
      // QuickJS raises InternalError for both exhausted memory and stack overflow.
      try {
        if (c && c.name === 'InternalError') return c.message === 'out of memory' ? 'out of memory while printing the error' : 'stack overflow while printing the error';
        return 'a thrown value with no string form';
      }
      catch (_) { return 'a thrown value with no string form'; }
    }
    if (m === '') return 'an empty ' + (typeof e) + ' was thrown';
    return apply(slice, m, [0, maxMessage + 1]);
  }
  // JSON.stringify recurses in QuickJS's C code without its stack check, so a
  // value nested a few thousand levels deep overflows the host stack and
  // aborts the shared module (#1922). Walk it first, iteratively, with a
  // hand-indexed stack (Array.prototype.push is script-patchable).
  // Same bound as bridge/json-bounds.ts checkJsonBounds, which this sandbox-side
  // string cannot import.
  // 0: fine, 1: nested too deep, 2: too many nodes to check (and to return).
  function shape(v) {
    if (v === null || typeof v !== 'object') return 0;
    var objs = [v], depths = [1], n = 1, seen = 0;
    while (n > 0) {
      n--;
      var o = objs[n], d = depths[n];
      if (d > maxDepth) return 1;
      var ks = keys(o);
      for (var i = 0; i < ks.length; i++) {
        if (++seen > maxNodes) return 2;
        var x = o[ks[i]];
        if (x !== null && typeof x === 'object') { objs[n] = x; depths[n] = d + 1; n++; }
      }
    }
    return 0;
  }
  function env(v) {
    var j, s;
    try { s = shape(v); } catch (e) { return 'U' + msg(e); }
    if (s === 1) return 'Uthe value is nested deeper than ' + maxDepth + ' levels (or is cyclic)';
    if (s === 2) return 'P[value too large to preview: over ' + maxNodes + ' nested properties]';
    try { j = stringify(v); } catch (e) { return 'U' + msg(e); }
    if (j === undefined) return 'Jnull';
    return j.length > max ? 'P' + apply(slice, j, [0, preview + 1]) : 'J' + j;
  }
  function fail(e) { return 'T' + msg(e); }
  var r, isPromise;
  try { r = run(); isPromise = apply(isInstance, P, [r]); } catch (e) { return fail(e); }
  if (!isPromise) return env(r);
  // Settle through a promise the wrapper owns: then() on the script's
  // promise builds its result via the script-controlled species constructor,
  // and a throwing constructor getter becomes an ordinary script failure.
  return new P(function (resolve) {
    // Each callback resolves even if building its envelope throws (e.g. out
    // of memory), so the wrapper promise cannot be left pending by it.
    try {
      apply(then, r, [
        function (v) { try { resolve(env(v)); } catch (_) { resolve('Uthe result envelope could not be built'); } },
        function (e) { try { resolve(fail(e)); } catch (_) { resolve('Tthe error envelope could not be built'); } },
      ]);
    }
    catch (e) { resolve(fail(e)); }
  });
})(function () { return eval(${JSON.stringify(code)}); }, Promise, Function.prototype[Symbol.hasInstance], Promise.prototype.then, Reflect.apply, String.prototype.slice, String, JSON.stringify, Object.keys, ${MAX_VALUE_CHARS}, ${VALUE_PREVIEW_CHARS}, ${MAX_MESSAGE_CHARS}, ${MAX_VALUE_DEPTH}, ${MAX_VALUE_NODES})`;
}

type Outcome =
  | { value: unknown; value_truncated: false }
  | { value: null; value_truncated: true; value_preview: string }
  | { error: string };

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
    // An out-of-memory here gets the memory_mb hint from hintFor.
    case 'U': return { error: `The script's value is not JSON-serialisable: ${clipMessage(body)}` };
    case 'T': return { error: clipMessage(body) };
    default: return { error: 'The script produced no result.' };
  }
}
