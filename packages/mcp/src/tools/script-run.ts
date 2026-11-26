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
 * `script_run` builds a sandbox with no `bim.mutate`, `bim.store`,
 * `bim.export` or `bim.create` namespaces at all. Neither tool gets network, files, viewer or UI access.
 *
 * Every call gets a fresh sandbox, disposed in `finally`. The QuickJS
 * interrupt handler enforces `timeout_ms` on script code, and the sandbox
 * stops waiting on async host work at the same deadline. The client's cancel
 * signal disposes the sandbox, which takes effect at a host-work await: script
 * code itself runs synchronously on the event loop. `memory_mb` caps the
 * QuickJS heap.
 */

import { createSandbox, SANDBOX_CONSOLE_LEVELS, ScriptError, type SandboxPermissions } from '@ifc-lite/sandbox';
import { MAX_VALUE_CHARS, clipMessage, readEnvelope, shapeLogs } from './script-output.js';
import { wrapScript } from './script-wrapper.js';
import type { JsonSchema } from '../protocol/index.js';
import type { LoadedModel, ToolContext } from '../context.js';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError, describeThrown } from '../errors.js';

const MAX_CODE_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 10_000;
// Script code runs synchronously on the server's event loop, so this also
// bounds how long one call can hold up every other request. Follow-up: run
// the sandbox in a worker thread so a script no longer blocks other sessions.
const MAX_TIMEOUT_MS = 30_000;
/**
 * Sandboxes alive at once, process-wide. All of them share one QuickJS WASM
 * module whose linear memory never shrinks, so overlapping runs that await
 * host work could otherwise each reserve up to MAX_MEMORY_MB.
 */
const MAX_CONCURRENT_SCRIPTS = 2;
let runningScripts = 0;
const DEFAULT_MEMORY_MB = 64;
// Kept well under the 4 GB wasm32 ceiling: the QuickJS module's linear memory
// is shared by every sandbox and does not shrink after a run.
const MAX_MEMORY_MB = 128;
/**
 * QuickJS stack ceiling. At the sandbox's 512 KB default, runaway recursion
 * overflows Node's own stack first: the host sees a RangeError and teardown
 * aborts QuickJS (#1922), retiring the shared WASM module. 256 KB still let
 * recursion that re-enters QuickJS's C code (String(o) inside toString, a
 * self-reading getter) overflow the host. At 128 KB every recursion shape
 * probed raises QuickJS's own catchable 'stack overflow' and disposes cleanly.
 * JSON serialisation recurses without that check at any ceiling, so the
 * wrapper serialises values and console arguments itself (script-wrapper.ts).
 */
const MAX_STACK_BYTES = 128 * 1024;

type Mode = 'read' | 'mutate';

// No `export` in read mode: it also enables bim.create, whose IfcCreator
// projects live on the host heap where memory_mb does not reach.
const READ_PERMISSIONS: SandboxPermissions = {
  model: true, query: true, lens: true, export: false,
  mutate: false, store: false, viewer: false, files: false, ui: false, network: false,
};
const MUTATE_PERMISSIONS: SandboxPermissions = { ...READ_PERMISSIONS, export: true, mutate: true, store: true };
/** The namespaces script_run lacks and script_run_mutate has (export also gates create). */
const MUTATE_ONLY_NAMESPACES = ['mutate', 'store', 'export', 'create'] as const;
const MUTATE_ONLY_LIST = MUTATE_ONLY_NAMESPACES.map((n) => `bim.${n}`).join(', ');
const MUTATE_ONLY_USE = new RegExp(`\\bbim\\.(${MUTATE_ONLY_NAMESPACES.join('|')})\\b`);

const inputSchema: JsonSchema = {
  type: 'object',
  required: ['code'],
  properties: {
    model_id: { type: 'string', description: 'Loaded model id; required when multiple models are loaded.' },
    code: {
      type: 'string', minLength: 1, maxLength: MAX_CODE_CHARS,
      description: 'JavaScript (not TypeScript) run with the sandbox `bim` global. The value of the last expression is returned and must be JSON-serialisable; if it is a native promise (e.g. an async IIFE around bim.clash.run) its resolved value is returned; thenables are not awaited. Top-level await is not supported. Wrap an object literal result in parentheses, ({ a: 1 }): a leading { is a block.',
    },
    timeout_ms: {
      type: 'integer', minimum: 100, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS,
      description: `Execution time limit in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). Script code is interrupted when it is exceeded; a single synchronous bim.* call already running is not cut short. Script code runs on the server's event loop, so other requests and a cancel wait until it yields or is interrupted. bim calls the script starts but does not await still count: if they outlast the limit the run is a TIMEOUT. The limit is wall-clock from when the script starts running, so once it has started, time spent waiting behind another session's script counts too.`,
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
  required: ['model_id', 'mode', 'value', 'value_truncated', 'logs', 'logs_truncated', 'duration_ms'],
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
        properties: { level: { type: 'string', enum: [...SANDBOX_CONSOLE_LEVELS] }, text: { type: 'string' } },
      },
    },
    logs_truncated: { type: 'boolean' },
    duration_ms: { type: 'number' },
    mutations_queued: { type: 'integer', minimum: 0, description: 'Mutation journal entries this script added (an edit it later undid still counts); persist pending edits with export_ifc or model_save. Counts every edit that landed on the model during the run, so a concurrent call editing the same model is included. Absent if the model was unloaded during the run.' },
  },
};

function intInput(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `${name} must be an integer from ${min} through ${max}.` });
  }
  return value as number;
}

function journalMutationIds(model: LoadedModel): string[] {
  return model.backend.getMutationView()?.getMutations().map((m) => m.id) ?? [];
}

// The QuickJS forms only (InternalError, the wrapper's own wording), so a
// script's own 'out of memory' text does not earn the hint.
const OUT_OF_MEMORY = /(^|: )(InternalError: )?out of memory\b|out of memory while printing|envelope could not be built/;

function hintFor(mode: Mode, code: string, message: string): string | undefined {
  if (OUT_OF_MEMORY.test(message)) return `Raise memory_mb (max ${MAX_MEMORY_MB}) or keep less in memory.`;
  if (/(^|: )(InternalError: )?stack overflow|stack overflow while printing|Maximum call stack size exceeded/.test(message)) return 'Stack overflow: the script recursed too deep (make it iterative or shallower), a logged value is nested too deeply, or a bim call walked a very deeply nested model.';
  // Only when the failure looks like touching a namespace that is absent.
  if (mode === 'read' && MUTATE_ONLY_USE.test(code) && /of undefined|undefined is not/.test(message)) {
    return `script_run has no ${MUTATE_ONLY_LIST}; use script_run_mutate for them.`;
  }
  return undefined;
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
    code: ToolErrorCode.INVALID_INPUT,
    // Envelope messages arrive clipped; a ScriptError's is clipped where it is caught.
    message: `Script error: ${message}`,
    details: { kind: 'script', ...details },
    hint: hintFor(mode, code, message),
  });
  if (ctx.signal.aborted) throw cancelled();

  // Read mode has no write namespaces, so it cannot queue anything. In mutate
  // mode the count is mutation-journal entries that appeared during the run; a
  // concurrent tool call editing the same model would be counted too.
  // Counted by id, so mutations the script undoes are not subtracted. Taken
  // right before eval, so edits landing during sandbox creation are not counted.
  let before: ReadonlySet<string> | null = null;
  // Undefined when the model was unloaded mid-run (its backend is disposed):
  // the count is lost, but the run's own outcome must still come through.
  const queued = (): number | undefined => {
    if (mode !== 'mutate' || before === null) return 0;
    // An unloaded model keeps a live mutation view but its edits can no
    // longer be saved, so report no count rather than advice to persist.
    if (ctx.registry.get(model.id) !== model) return undefined;
    const baseline = before;
    try {
      return journalMutationIds(model).filter((id) => !baseline.has(id)).length;
    } catch (err) {
      ctx.log.log('warning', 'script_run: could not count queued mutations', { error: describeThrown(err) });
      return undefined;
    }
  };
  return withScriptSlot(async () => {
    const sandbox = await createSandbox(model.bim, {
      permissions: mode === 'mutate' ? MUTATE_PERMISSIONS : READ_PERMISSIONS,
      limits: { timeoutMs, memoryBytes: memoryMb * 1024 * 1024, maxStackBytes: MAX_STACK_BYTES },
    });
    // dispose() can throw SandboxAbortError when QuickJS aborts tearing down a
    // runtime (#1922). From the abort listener that would be an uncaught
    // exception; from `finally` it would replace the real outcome.
    const dispose = () => {
      try {
        sandbox.dispose();
      } catch (err) {
        ctx.log.log('warning', 'script_run: sandbox teardown aborted', { error: err instanceof Error ? err.message : String(err) });
      }
    };
    const onAbort = () => dispose();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    // A cancel that landed while the sandbox was being created fired no event.
    if (ctx.signal.aborted) onAbort();
    try {
      if (ctx.signal.aborted) throw cancelled();
      if (mode === 'mutate') before = new Set(journalMutationIds(model));
      const result = await sandbox.eval(wrapScript(code), { typescript: false, filename: 'script_run.js' });
      const { logs, truncated } = shapeLogs(result.logs);
      const mutationsQueued = queued();
      // A cancel that landed during the last host-work drain still wins.
      if (ctx.signal.aborted) throw cancelled({ logs, logs_truncated: truncated, mutations_queued: mutationsQueued });
      const outcome = readEnvelope(result.value);
      if ('error' in outcome) throw scriptError(outcome.error, { logs, logs_truncated: truncated, mutations_queued: mutationsQueued });
      const summary = [
        `Script ran in ${result.durationMs} ms on model '${model.id}' (${mode}).`,
        (mutationsQueued ?? 0) > 0 ? `${mutationsQueued} mutation(s) queued; persist with export_ifc or model_save.` : '',
        outcome.value_truncated ? `Value truncated (over ${MAX_VALUE_CHARS} JSON characters).` : '',
        truncated ? 'Logs truncated.' : '',
      ].filter(Boolean).join(' ');
      const structured = {
        model_id: model.id, mode, ...outcome, logs, logs_truncated: truncated, duration_ms: result.durationMs,
        ...(mutationsQueued !== undefined ? { mutations_queued: mutationsQueued } : {}),
      };
      // The serialised result goes in the text block too, for clients that
      // read only `content` (MCP 2025-06-18, structured content).
      // The JSON gets its own last block, like the error envelope fitOutputSchema adds.
      const toolResult = okResult(summary, structured);
      toolResult.content.push({ type: 'text', text: JSON.stringify(structured) });
      return toolResult;
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      // A sandbox disposed by a cancel rejects with a plain Error
      // that carries no logs; only a ScriptError has them.
      const shaped = err instanceof ScriptError ? shapeLogs(err.logs) : { logs: [], truncated: false };
      const details = { logs: shaped.logs, logs_truncated: shaped.truncated, mutations_queued: queued() };
      if (ctx.signal.aborted) throw cancelled(details);
      // Script throws are caught in the wrapper, so 'interrupted' here is the
      // sandbox's own interrupt handler (it reports nothing more specific).
      if (err instanceof ScriptError && err.message === 'interrupted') {
        throw new ToolExecutionError({
          code: ToolErrorCode.TIMEOUT, message: `Script exceeded timeout_ms (${timeoutMs}).`, details,
          hint: `Raise timeout_ms (max ${MAX_TIMEOUT_MS}) or do less per call; un-awaited bim calls count toward it.`,
        });
      }
      // The sandbox's own realm failing is a server fault, not the script's.
      if (err instanceof ScriptError && err.message.startsWith('Sandbox realm became invalid')) {
        throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: err.message, details });
      }
      // Out of memory, stack overflow, or a fault the wrapper could not catch.
      // A host RangeError counts as the script's only when it is recursion that
      // outran the host stack despite MAX_STACK_BYTES; others are server faults.
      const hostStackOverflow = err instanceof RangeError && /call stack/i.test(err.message);
      if (err instanceof ScriptError || hostStackOverflow) throw scriptError(clipMessage(err.message), details);
      // Keep mutations_queued on every failure, not only script ones.
      throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: describeThrown(err), details });
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      dispose();
    }
  });
}

/** Holds one of the process-wide script slots for the duration of `run`. */
async function withScriptSlot<T>(run: () => Promise<T>): Promise<T> {
  if (runningScripts >= MAX_CONCURRENT_SCRIPTS) {
    throw new ToolExecutionError({
      code: ToolErrorCode.RATE_LIMITED,
      message: `${MAX_CONCURRENT_SCRIPTS} scripts are already running on this server; retry when one finishes.`,
    });
  }
  runningScripts++;
  try {
    return await run();
  } finally {
    runningScripts--;
  }
}

const SHARED_DESCRIPTION = `Runs in a QuickJS sandbox with only the \`bim\` SDK global (bim.query, bim.model, bim.lens, bim.clash, bim.cost, bim.structural, bim.schedule; script_run_mutate adds ${MUTATE_ONLY_LIST}) and console; no network, filesystem, viewer or timers. Returns the last expression value plus captured console output. memory_mb bounds the QuickJS heap only, not data bim calls build on the host (such as bim.create projects in script_run_mutate). Script code runs on the server's event loop, so other requests wait while it runs (bounded by timeout_ms). At most ${MAX_CONCURRENT_SCRIPTS} scripts run at once per server process, shared across all sessions; more get RATE_LIMITED.`;

export const scriptRunTool: Tool = {
  name: 'script_run',
  title: 'Run SDK script (read-only)',
  description: `script, eval, javascript, sdk: run a read-only SDK script against a loaded model. ${SHARED_DESCRIPTION} ${MUTATE_ONLY_LIST} are absent; use script_run_mutate for them.`,
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
