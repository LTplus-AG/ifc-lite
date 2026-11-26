/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * script_run / script_run_mutate: run an SDK script against a loaded model
 * in the QuickJS sandbox (`@ifc-lite/sandbox`), the same engine behind
 * `bim.sandbox`, the viewer script panel and the flow script node.
 *
 * Two tools rather than one with a flag, so the server's static gates do the
 * work: `--read-only` and a token without the `mutate` scope hide
 * `script_run_mutate` from `tools/list` and refuse it at dispatch, and
 * `script_run` builds a sandbox with no `bim.mutate` / `bim.store`
 * namespaces at all. Neither tool gets network, files, viewer or UI access.
 *
 * Every call gets a fresh sandbox, disposed in `finally`. The QuickJS
 * interrupt handler enforces `timeout_ms`; a host timer and the client's
 * cancel signal dispose the sandbox if host work (an async bridge call)
 * outlives it. `memory_mb` caps the QuickJS heap.
 */

import { createSandbox, ScriptError, type LogEntry, type SandboxPermissions } from '@ifc-lite/sandbox';
import type { JsonSchema } from '../protocol/index.js';
import type { LoadedModel, ToolContext } from '../context.js';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

const MAX_CODE_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY_MB = 64;
const MAX_MEMORY_MB = 256;
/** Grace after `timeout_ms` before the host tears the sandbox down itself. */
const HOST_GRACE_MS = 2_000;
/** Caps on what one call returns to the client (the sandbox caps capture at 1000 entries / 4 MB). */
const MAX_VALUE_CHARS = 256 * 1024;
const VALUE_PREVIEW_CHARS = 2_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 64 * 1024;

type Mode = 'read' | 'mutate';

const READ_PERMISSIONS: SandboxPermissions = {
  model: true, query: true, lens: true, export: true,
  mutate: false, store: false, viewer: false, files: false, ui: false, network: false,
};
const MUTATE_PERMISSIONS: SandboxPermissions = { ...READ_PERMISSIONS, mutate: true, store: true };

const inputSchema: JsonSchema = {
  type: 'object',
  required: ['code'],
  properties: {
    model_id: { type: 'string', description: 'Loaded model id; required when multiple models are loaded.' },
    code: {
      type: 'string', minLength: 1, maxLength: MAX_CODE_CHARS,
      description: 'JavaScript (not TypeScript) run with the sandbox `bim` global. The value of the last expression is returned and must be JSON-serialisable; if it is a promise (e.g. an async IIFE around bim.clash.run) its resolved value is returned. Top-level await is not supported.',
    },
    timeout_ms: {
      type: 'integer', minimum: 100, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS,
      description: `Execution time limit in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). Script code is interrupted when it is exceeded; a single synchronous bim.* call already running is not cut short.`,
    },
    memory_mb: {
      type: 'integer', minimum: 8, maximum: MAX_MEMORY_MB, default: DEFAULT_MEMORY_MB,
      description: `Sandbox heap limit in MiB (default ${DEFAULT_MEMORY_MB}, max ${MAX_MEMORY_MB}).`,
    },
  },
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: 'object',
  required: ['model_id', 'mode', 'value', 'value_truncated', 'logs', 'logs_truncated', 'duration_ms', 'mutations_queued'],
  properties: {
    model_id: { type: 'string' },
    mode: { type: 'string', enum: ['read', 'mutate'] },
    value: { description: 'Value of the last expression; null when it was undefined or truncated.' },
    value_truncated: { type: 'boolean' },
    value_preview: { type: 'string', description: 'First characters of the JSON value, present only when value_truncated.' },
    logs: {
      type: 'array',
      items: {
        type: 'object', required: ['level', 'text'],
        properties: { level: { type: 'string', enum: ['log', 'info', 'warn', 'error'] }, text: { type: 'string' } },
      },
    },
    logs_truncated: { type: 'boolean' },
    duration_ms: { type: 'number' },
    mutations_queued: { type: 'integer', minimum: 0, description: 'Mutations this script added that are still pending; persist with export_ifc or model_save.' },
  },
};

function intInput(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `${name} must be an integer from ${min} through ${max}.` });
  }
  return value as number;
}

function pendingMutationIds(model: LoadedModel): string[] {
  return model.backend.getMutationView()?.getMutations().map((m) => m.id) ?? [];
}

type LogLine = { level: string; text: string };

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

function shapeLogs(entries: readonly LogEntry[]): { logs: LogLine[]; truncated: boolean } {
  const logs: LogLine[] = [];
  let chars = 0;
  for (const entry of entries) {
    if (logs.length >= MAX_LOG_LINES) return { logs, truncated: true };
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
function wrapScript(code: string): string {
  // The script's function is created in the global scope, outside the
  // helpers' closure, and the Promise/JSON primitives are bound before it
  // runs, so a script that declares or assigns `env`, or reassigns
  // `Promise`, cannot reach what the wrapper relies on. The envelope is a
  // tagged primitive string, which no prototype or toJSON patch can reshape
  // on its way through vm.dump, and an oversized value is cut down inside the
  // sandbox so only the preview crosses to the host.
  return `(function (run, P, isInstance, then, apply, slice, Str, stringify, max, preview) {
  function msg(e) {
    try { return e && typeof e.message === 'string' ? e.message : Str(e); }
    catch (_) { return 'unprintable error'; }
  }
  function env(v) {
    var j;
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
    try { apply(then, r, [function (v) { resolve(env(v)); }, function (e) { resolve(fail(e)); }]); }
    catch (e) { resolve(fail(e)); }
  });
})(function () { return eval(${JSON.stringify(code)}); }, Promise, Function.prototype[Symbol.hasInstance], Promise.prototype.then, Reflect.apply, String.prototype.slice, String, JSON.stringify, ${MAX_VALUE_CHARS}, ${VALUE_PREVIEW_CHARS})`;
}

type Outcome =
  | { value: unknown; value_truncated: false }
  | { value: null; value_truncated: true; value_preview: string }
  | { error: string };

/** Decode the wrapper's tagged string (a returned promise dumps as `{ type, value }`). */
function readEnvelope(dumped: unknown): Outcome {
  const state = dumped as { type?: string; value?: unknown };
  if (state?.type === 'pending') return { error: 'The script returned a promise that never settled (only bim host calls resolve; there are no timers).' };
  const envelope = state?.type === 'fulfilled' ? state.value : dumped;
  if (typeof envelope !== 'string') return { error: 'The script produced no result.' };
  // The wrapper bounds these; the host re-checks so a script that subverted
  // it still cannot pass an unbounded value or message on to the client.
  const body = envelope.slice(1, envelope[0] === 'J' ? undefined : MAX_MESSAGE_CHARS + 1);
  switch (envelope[0]) {
    case 'J':
      if (body.length <= MAX_VALUE_CHARS) return { value: JSON.parse(body) as unknown, value_truncated: false };
    // The wrapper cuts one unit past the preview so this clip can back off a
    // split surrogate pair. An over-cap J body is a preview like P.
    // falls through
    case 'P': return { value: null, value_truncated: true, value_preview: clipUtf16(body, VALUE_PREVIEW_CHARS) };
    case 'U': return { error: /out of memory/i.test(body)
      ? 'Ran out of memory serialising the value; raise memory_mb or return less.'
      : `The script's value is not JSON-serialisable: ${clipUtf16(body, MAX_MESSAGE_CHARS)}` };
    case 'T': return { error: clipUtf16(body, MAX_MESSAGE_CHARS) };
    default: return { error: 'The script produced no result.' };
  }
}

async function runScript(mode: Mode, input: Record<string, unknown>, ctx: ToolContext) {
  const model = resolveModel(ctx, input.model_id as string | undefined);
  const code = input.code;
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_CHARS) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `code must be a non-empty string of at most ${MAX_CODE_CHARS} characters.` });
  }
  const timeoutMs = intInput(input.timeout_ms, 'timeout_ms', 100, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const memoryMb = intInput(input.memory_mb, 'memory_mb', 8, MAX_MEMORY_MB, DEFAULT_MEMORY_MB);
  const cancelled = (details?: Record<string, unknown>) =>
    new ToolExecutionError({ code: ToolErrorCode.CANCELLED, message: 'Script cancelled by the client.', details });
  const scriptError = (message: string, details: Record<string, unknown>) => new ToolExecutionError({
    // kind tells a script failure from INVALID_INPUT on the tool's own arguments.
    // Clipped here too: a ScriptError from the sandbox can carry a script-sized message.
    code: ToolErrorCode.INVALID_INPUT, message: `Script error: ${clipUtf16(message, MAX_MESSAGE_CHARS)}`, details: { kind: 'script', ...details },
    hint: mode === 'read' && /\bbim\.(mutate|store)\b/.test(code)
      ? 'script_run has no bim.mutate or bim.store; use script_run_mutate to edit the model.'
      : undefined,
  });
  if (ctx.signal.aborted) throw cancelled();

  // Read mode has no write namespaces, so it cannot queue anything. In mutate
  // mode the count is pending mutations that appeared during the run; a
  // concurrent tool call editing the same model would be counted too.
  // Counted by id, so mutations the script undoes are not subtracted.
  const before = new Set(mode === 'mutate' ? pendingMutationIds(model) : []);
  const queued = () => (mode === 'mutate' ? pendingMutationIds(model).filter((id) => !before.has(id)).length : 0);
  const sandbox = await createSandbox(model.bim, {
    permissions: mode === 'mutate' ? MUTATE_PERMISSIONS : READ_PERMISSIONS,
    limits: { timeoutMs, memoryBytes: memoryMb * 1024 * 1024 },
  });
  // dispose() can throw SandboxAbortError when QuickJS aborts tearing down a
  // runtime (#1922). From the timer or abort listener that would be an
  // uncaught exception; from `finally` it would replace the real outcome.
  const dispose = () => {
    try {
      sandbox.dispose();
    } catch (err) {
      ctx.log.log('warning', 'script_run: sandbox teardown aborted', { error: err instanceof Error ? err.message : String(err) });
    }
  };
  let stopReason: 'cancelled' | 'timeout' | null = null;
  const stop = (reason: 'cancelled' | 'timeout') => { stopReason ??= reason; dispose(); };
  const onAbort = () => stop('cancelled');
  const timer = setTimeout(() => stop('timeout'), timeoutMs + HOST_GRACE_MS);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  // A cancel that landed while the sandbox was being created fired no event.
  if (ctx.signal.aborted) onAbort();
  try {
    if (stopReason) throw cancelled();
    const result = await sandbox.eval(wrapScript(code), { typescript: false, filename: 'script_run.js' });
    const { logs, truncated } = shapeLogs(result.logs);
    const mutationsQueued = queued();
    const outcome = readEnvelope(result.value);
    if ('error' in outcome) throw scriptError(outcome.error, { logs, logs_truncated: truncated, mutations_queued: mutationsQueued });
    const summary = [
      `Script ran in ${result.durationMs} ms on model '${model.id}' (${mode}).`,
      mutationsQueued > 0 ? `${mutationsQueued} mutation(s) queued; persist with export_ifc or model_save.` : '',
      outcome.value_truncated ? `Value truncated (over ${MAX_VALUE_CHARS} JSON characters).` : '',
    ].filter(Boolean).join(' ');
    const structured = {
      model_id: model.id, mode, ...outcome, logs, logs_truncated: truncated,
      duration_ms: result.durationMs, mutations_queued: mutationsQueued,
    };
    // The serialised result goes in the text block too, for clients that
    // read only `content` (MCP 2025-06-18, structured content).
    return okResult(`${summary}\n${JSON.stringify(structured)}`, structured);
  } catch (err) {
    if (err instanceof ToolExecutionError) throw err;
    // A sandbox disposed by the timer or a cancel rejects with a plain Error
    // that carries no logs; only a ScriptError has them.
    const shaped = err instanceof ScriptError ? shapeLogs(err.logs) : { logs: [], truncated: false };
    const details = { logs: shaped.logs, logs_truncated: shaped.truncated, mutations_queued: queued() };
    if (stopReason === 'cancelled') throw cancelled(details);
    // Script throws are caught in the wrapper, so 'interrupted' here is the
    // sandbox's own interrupt handler (it reports nothing more specific).
    if (stopReason === 'timeout' || (err instanceof ScriptError && err.message === 'interrupted')) {
      throw new ToolExecutionError({ code: ToolErrorCode.TIMEOUT, message: `Script exceeded timeout_ms (${timeoutMs}).`, details });
    }
    // Out of memory, stack overflow, or a fault the wrapper could not catch.
    if (err instanceof ScriptError) throw scriptError(err.message, details);
    throw err;
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
    dispose();
  }
}

const SHARED_DESCRIPTION = 'Runs in a QuickJS sandbox with only the `bim` SDK global (bim.query, bim.model, bim.export, bim.lens, bim.clash, bim.cost, bim.structural, bim.schedule, bim.create) and console; no network, filesystem, viewer or timers. Returns the last expression value plus captured console output.';

export const scriptRunTool: Tool = {
  name: 'script_run',
  title: 'Run SDK script (read-only)',
  description: `script, eval, javascript, sdk: run a read-only SDK script against a loaded model. ${SHARED_DESCRIPTION} bim.mutate and bim.store are absent; use script_run_mutate to edit.`,
  scope: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema,
  outputSchema,
  handler: (input, ctx) => runScript('read', input, ctx),
};

export const scriptRunMutateTool: Tool = {
  name: 'script_run_mutate',
  title: 'Run SDK script (can edit)',
  description: `script, eval, javascript, sdk, edit: run an SDK script that may edit the model through bim.mutate and bim.store. ${SHARED_DESCRIPTION} Edits are queued like other mutation tools (mutation_diff, mutation_undo) and persist only via export_ifc or model_save. Not atomic: if the script throws, times out or is cancelled, edits made before that stay queued and the error's details.mutations_queued says how many. Hidden in --read-only mode.`,
  scope: 'mutate',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema,
  outputSchema,
  handler: (input, ctx) => runScript('mutate', input, ctx),
};

export const scriptTools: Tool[] = [scriptRunTool, scriptRunMutateTool];
