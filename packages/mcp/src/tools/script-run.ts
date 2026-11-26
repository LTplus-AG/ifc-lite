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
import type { Mutation } from '@ifc-lite/mutations';
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
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 64 * 1024;

type Mode = 'read' | 'mutate';

const READ_PERMISSIONS: SandboxPermissions = {
  model: true, query: true, lens: true, export: true,
  mutate: false, store: false, viewer: false, files: false, ui: false, network: false,
};
const MUTATE_PERMISSIONS: SandboxPermissions = { ...READ_PERMISSIONS, mutate: true, store: true };

function inputSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['code'],
    properties: {
      model_id: { type: 'string', description: 'Loaded model id; required when multiple models are loaded.' },
      code: {
        type: 'string', minLength: 1, maxLength: MAX_CODE_CHARS,
        description: 'JavaScript (not TypeScript) run with the sandbox `bim` global. The value of the last expression is returned; it must be JSON-serialisable. Top-level await is not supported.',
      },
      timeout_ms: {
        type: 'integer', minimum: 100, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS,
        description: `Execution time limit in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). The script is interrupted when it is exceeded.`,
      },
      memory_mb: {
        type: 'integer', minimum: 8, maximum: MAX_MEMORY_MB, default: DEFAULT_MEMORY_MB,
        description: `Sandbox heap limit in MiB (default ${DEFAULT_MEMORY_MB}, max ${MAX_MEMORY_MB}).`,
      },
    },
    additionalProperties: false,
  };
}

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
    mutations_queued: { type: 'integer', description: 'Pending mutations this script added; persist with export_ifc or model_save.' },
  },
};

function intInput(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `${name} must be an integer from ${min} through ${max}.` });
  }
  return value as number;
}

function pendingMutationCount(model: LoadedModel): number {
  const view = model.backend.getMutationView();
  // Same narrow read as mutation_diff: the history array is private on the view.
  return (view as unknown as { mutationHistory?: Mutation[] } | null)?.mutationHistory?.length ?? 0;
}

function renderLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch (err) {
    return `[unserialisable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function shapeLogs(entries: readonly LogEntry[]): { logs: Array<{ level: string; text: string }>; truncated: boolean } {
  const logs: Array<{ level: string; text: string }> = [];
  let chars = 0;
  for (const entry of entries) {
    const text = entry.args.map(renderLogArg).join(' ');
    if (logs.length >= MAX_LOG_LINES || chars + text.length > MAX_LOG_CHARS) return { logs, truncated: true };
    chars += text.length;
    logs.push({ level: entry.level, text });
  }
  return { logs, truncated: false };
}

function shapeValue(value: unknown): { value: unknown; value_truncated: boolean; value_preview?: string } {
  if (value === undefined) return { value: null, value_truncated: false };
  const json = JSON.stringify(value);
  if (json === undefined) return { value: null, value_truncated: false };
  if (json.length <= MAX_VALUE_CHARS) return { value, value_truncated: false };
  return { value: null, value_truncated: true, value_preview: json.slice(0, 2_000) };
}

async function runScript(mode: Mode, input: Record<string, unknown>, ctx: ToolContext) {
  const model = resolveModel(ctx, input.model_id as string | undefined);
  const code = input.code;
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_CHARS) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `code must be a non-empty string of at most ${MAX_CODE_CHARS} characters.` });
  }
  const timeoutMs = intInput(input.timeout_ms, 'timeout_ms', 100, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const memoryMb = intInput(input.memory_mb, 'memory_mb', 8, MAX_MEMORY_MB, DEFAULT_MEMORY_MB);
  if (ctx.signal.aborted) throw new ToolExecutionError({ code: ToolErrorCode.CANCELLED, message: 'Cancelled before the script started.' });

  const before = pendingMutationCount(model);
  const sandbox = await createSandbox(model.bim, {
    permissions: mode === 'mutate' ? MUTATE_PERMISSIONS : READ_PERMISSIONS,
    limits: { timeoutMs, memoryBytes: memoryMb * 1024 * 1024 },
  });
  let stopReason: 'cancelled' | 'timeout' | null = null;
  const stop = (reason: 'cancelled' | 'timeout') => { stopReason ??= reason; sandbox.dispose(); };
  const onAbort = () => stop('cancelled');
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('timeout'), timeoutMs + HOST_GRACE_MS);
  try {
    // A direct eval inside a function gives the script its own variable
    // environment and still returns its completion value (the flow script
    // node does the same). Plain JS: the TypeScript strip needs esbuild-wasm,
    // which does not initialise under Node.
    const wrapped = `(function () { return eval(${JSON.stringify(code)}); })()`;
    const result = await sandbox.eval(wrapped, { typescript: false, filename: 'script_run.js' });
    const { logs, truncated } = shapeLogs(result.logs);
    const mutationsQueued = pendingMutationCount(model) - before;
    const shaped = shapeValue(result.value);
    const summary = [
      `Script ran in ${result.durationMs} ms on model '${model.id}' (${mode}).`,
      mutationsQueued > 0 ? `${mutationsQueued} mutation(s) queued; persist with export_ifc or model_save.` : '',
      shaped.value_truncated ? `Value truncated (over ${MAX_VALUE_CHARS} JSON characters).` : '',
    ].filter(Boolean).join(' ');
    return okResult(summary, {
      model_id: model.id, mode, ...shaped, logs, logs_truncated: truncated,
      duration_ms: result.durationMs, mutations_queued: mutationsQueued,
    });
  } catch (err) {
    if (stopReason === 'cancelled') throw new ToolExecutionError({ code: ToolErrorCode.CANCELLED, message: 'Script cancelled by the client.' });
    if (stopReason === 'timeout') throw new ToolExecutionError({ code: ToolErrorCode.TIMEOUT, message: `Script exceeded timeout_ms (${timeoutMs}).` });
    if (err instanceof ScriptError) {
      const interrupted = err.message === 'interrupted';
      throw new ToolExecutionError({
        code: interrupted ? ToolErrorCode.TIMEOUT : ToolErrorCode.INVALID_INPUT,
        message: interrupted ? `Script exceeded timeout_ms (${timeoutMs}).` : `Script error: ${err.message}`,
        details: { logs: shapeLogs(err.logs).logs, mutations_queued: pendingMutationCount(model) - before },
        hint: mode === 'read' && /\bbim\.(mutate|store)\b/.test(code)
          ? 'script_run has no bim.mutate or bim.store; use script_run_mutate to edit the model.'
          : undefined,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
    sandbox.dispose();
  }
}

const SHARED_DESCRIPTION = 'Runs in a QuickJS sandbox with only the `bim` SDK global (bim.query, bim.model, bim.export, bim.lens, bim.clash, bim.cost, bim.structural, bim.schedule, bim.create) and console; no network, filesystem, viewer or timers. Returns the last expression value plus captured console output.';

export const scriptRunTool: Tool = {
  name: 'script_run',
  title: 'Run SDK script (read-only)',
  description: `script, eval, javascript, sdk: run a read-only SDK script against a loaded model. ${SHARED_DESCRIPTION} bim.mutate and bim.store are absent; use script_run_mutate to edit.`,
  scope: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: inputSchema(),
  outputSchema,
  handler: (input, ctx) => runScript('read', input, ctx),
};

export const scriptRunMutateTool: Tool = {
  name: 'script_run_mutate',
  title: 'Run SDK script (can edit)',
  description: `script, eval, javascript, sdk, edit: run an SDK script that may edit the model through bim.mutate and bim.store. ${SHARED_DESCRIPTION} Edits are queued like other mutation tools (mutation_diff, mutation_undo) and persist only via export_ifc or model_save. Hidden in --read-only mode.`,
  scope: 'mutate',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: inputSchema(),
  outputSchema,
  handler: (input, ctx) => runScript('mutate', input, ctx),
};

export const scriptTools: Tool[] = [scriptRunTool, scriptRunMutateTool];
