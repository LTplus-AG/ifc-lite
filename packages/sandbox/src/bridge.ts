/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge — exposes the `bim` API object inside the QuickJS sandbox.
 *
 * Architecture (Figma-inspired):
 * - No data lives inside the sandbox
 * - Every `bim.*` call crosses the WASM boundary to the host
 * - Entity objects in the sandbox are plain data { ref, name, type, ... }
 * - Property/quantity access triggers on-demand extraction on the host
 *
 * All namespaces (model, query, viewer, mutate, lens, export) are built
 * from declarative schemas in bridge-schema.ts.
 */

import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import type { BimContext } from '@ifc-lite/sdk';
import type { SandboxPermissions, LogEntry } from './types.js';
import { DEFAULT_PERMISSIONS } from './types.js';
import { HostWorkQueue } from './bridge-async.js';
import { buildSchemaNamespaces, disposeSchemaNamespaceSession, type BridgeCallContext } from './bridge-schema.js';

/**
 * Build the `bim` API object inside the QuickJS VM.
 *
 * Returns the captured log entries from console.* calls, plus `resetLogs` —
 * the caller must invoke it at the start of every run, because the capture
 * budget is scoped to one run (see `buildConsole`) — plus `hostWork`, the
 * queue of in-flight host promises the caller must settle before reading a
 * run's result (#2305, see bridge-async.ts).
 */
export function buildBridge(
  vm: QuickJSContext,
  sdk: BimContext,
  permissions: SandboxPermissions = {},
  context: BridgeCallContext,
): { logs: LogEntry[]; resetLogs: () => void; hostWork: HostWorkQueue; dispose: () => void } {
  const perms = { ...DEFAULT_PERMISSIONS, ...permissions } as Required<SandboxPermissions>;
  const logs: LogEntry[] = [];

  // ── console.log / warn / error / info ──────────────────────
  const resetLogs = buildConsole(vm, logs);

  // ── bim global ─────────────────────────────────────────────
  // The handle is freed in a `finally`: if namespace construction throws,
  // an orphaned handle would keep a JSObject alive past context teardown and
  // make the runtime's own dispose() abort the WASM module (#1905).
  const hostWork = new HostWorkQueue();
  const bimHandle = vm.newObject();
  try {
    // All namespaces are schema-driven (model, query, viewer, mutate, lens, export)
    buildSchemaNamespaces(vm, bimHandle, sdk, perms, context, hostWork);

    vm.setProp(vm.global, 'bim', bimHandle);
  } finally {
    bimHandle.dispose();
  }

  return {
    logs,
    resetLogs,
    hostWork,
    dispose: () => {
      // Before the vm/runtime frees: an unsettled deferred's resolver handles
      // are unmanaged lifetimes, and an orphan there aborts the module (#1905).
      hostWork.dispose();
      disposeSchemaNamespaceSession(context);
    },
  };
}

// ── Console ──────────────────────────────────────────────────

function buildConsole(vm: QuickJSContext, logs: LogEntry[]): () => void {
  const consoleHandle = vm.newObject();

  // vm.dump copies sandbox strings onto the host JS heap, which is NOT bound by
  // the QuickJS memoryBytes limit. Cap both entry count and cumulative
  // serialized size so an untrusted script (e.g. `for(;;) console.log('x'.repeat(1e6))`)
  // cannot exhaust host memory before the eval timeout fires.
  const MAX_LOG_ENTRIES = 1000;
  // 4MB host budget for captured logs. Sized via `JSON.stringify(...).length`,
  // which counts UTF-16 code units, not real UTF-8 bytes — for ASCII content
  // the two coincide, but multi-byte UTF-8 (e.g. CJK) is undercounted by up to
  // ~133% (`JSON.stringify(['日本語のログ出力']).length` is 12,
  // `Buffer.byteLength(...)` is 28). Switching to a byte-accurate measure
  // (`new TextEncoder().encode(str).length`, not `Buffer.byteLength` — this
  // runs in browsers too) was evaluated and deliberately not done: a
  // microbenchmark (`.length` vs `TextEncoder().encode().length` on 1MB/10MB
  // ASCII strings) measured the encode call ~1000-2000x slower than `.length`,
  // because it allocates a whole new buffer proportional to the string being
  // measured. That cost lands on every captured log call, including the
  // adversarial ones this budget exists to cheaply reject (e.g. a script
  // logging a single 40MB string) — before the entry is even rejected, sizing
  // it would itself allocate tens of MB of scratch buffer. Undercounting
  // code-unit length against a byte budget is a real gap, but not one worth
  // paying an O(n) allocation on every call, including the ones this cap is
  // supposed to make cheap to refuse. See #2117.
  const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
  let totalBytes = 0;
  let truncated = false;
  // The sizing failure below is script-controlled, so it must not be logged
  // per occurrence: `for(;;) console.log(1n)` would then flood the host
  // console. One notice per context is enough to make it non-silent.
  let sizingWarningShown = false;

  // The budget bounds *one run's* captured output: the buffer holds only the
  // current run (`resetLogs` empties it, and each result gets a copy), and the
  // eval timeout is what bounds how long a script has to fill it. So the
  // counters must reset with the buffer — a sandbox is reused across evals
  // (`bim.sandbox.eval`, and one sandbox per activated extension), and a
  // latched `truncated` would otherwise silence every later script for the
  // life of the sandbox (#2099). Resetting the buffer without the counters is
  // exactly the bug, so both happen here and `eval()` calls only this.
  const resetLogs = (): void => {
    logs.length = 0;
    totalBytes = 0;
    truncated = false;
  };

  try {
    for (const level of ['log', 'warn', 'error', 'info'] as const) {
      const fn = vm.newFunction(level, (...args: QuickJSHandle[]) => {
        if (truncated) return;
        // Entry-count is checked up front: it is a per-call increment of
        // exactly 1, so overshoot is bounded to one entry past the cap. The
        // byte budget cannot be checked this way — see below.
        if (logs.length >= MAX_LOG_ENTRIES) {
          truncated = true;
          logs.push({ level: 'warn', args: ['[log output truncated: limit reached]'], timestamp: Date.now() });
          return;
        }
        const nativeArgs = args.map(a => vm.dump(a));
        // Approximate host cost of retaining this entry.
        let entryArgs: unknown[] = nativeArgs;
        let entryBytes = 0;
        try {
          entryBytes = JSON.stringify(nativeArgs)?.length ?? 0;
        } catch (err) {
          // An entry that cannot be sized must not be retained as it is: it
          // would take one of the MAX_LOG_ENTRIES slots while adding nothing
          // to totalBytes, so a script could park host memory the 4MB budget
          // never sees (#2087). Keep the arguments that can be sized, swap
          // the rest for bounded text, and charge exactly what is kept.
          const retained = retainSizeableArgs(nativeArgs);
          entryArgs = retained.args;
          entryBytes = retained.bytes;
          if (!sizingWarningShown) {
            sizingWarningShown = true;
            console.warn(
              `[ifc-lite/sandbox] ${retained.replaced} captured log argument(s) could not be sized and were replaced by a placeholder; further occurrences in this context are not reported`,
              err,
            );
          }
        }
        // Checked AGAINST the entry about to be added, before it is pushed
        // (#2117): the old `totalBytes >= MAX_TOTAL_BYTES` check ran before
        // this entry's size was even known, so a single oversized argument
        // (e.g. a script logging one 40MB string) was retained in full — the
        // check only caught up on the *next* call, by which point the
        // overshoot had already happened and was bounded only by what the
        // script chose to log. Refusing here means the ceiling is an actual
        // ceiling: an entry that would push totalBytes over budget is dropped
        // in favor of the truncation marker, not retained.
        if (totalBytes + entryBytes > MAX_TOTAL_BYTES) {
          truncated = true;
          logs.push({ level: 'warn', args: ['[log output truncated: limit reached]'], timestamp: Date.now() });
          return;
        }
        totalBytes += entryBytes;
        logs.push({ level, args: entryArgs, timestamp: Date.now() });
      });
      try {
        vm.setProp(consoleHandle, level, fn);
      } finally {
        fn.dispose();
      }
    }

    vm.setProp(vm.global, 'console', consoleHandle);
  } finally {
    consoleHandle.dispose();
  }

  return resetLogs;
}

/**
 * Bound on the BigInt kept as text. Rendering a BigInt to decimal is itself a
 * memory hazard — a million-bit BigInt, which QuickJS will allocate, renders to
 * ~300k characters — while comparing against a bound is cheap, so anything
 * larger is described rather than printed.
 */
const MAX_RETAINED_BIGINT = 10n ** 64n;

/**
 * Bounded stand-in for a console argument the host cannot size.
 *
 * `vm.dump` flattens any sandbox value its own serializer rejects to the
 * string "[object Object]" (a cyclic object arrives as that string, already
 * stripped of its payload), so the value that actually reaches the host
 * unserializable is a top-level BigInt — and a BigInt is unbounded in size.
 * Every branch here returns at most ~70 characters.
 */
function describeUnsizeableArg(arg: unknown): string {
  if (typeof arg === 'bigint') {
    return arg < MAX_RETAINED_BIGINT && arg > -MAX_RETAINED_BIGINT
      ? `${arg}n`
      : '[BigInt too large to retain]';
  }
  return `[unserializable ${typeof arg} — not retained]`;
}

/**
 * Rebuild a dumped argument list so that every retained element has a known
 * serialized size, and report that size.
 *
 * The byte budget can only cap what it can measure: retaining an argument
 * whose size is unknown lets a script hold host memory for free (#2087).
 * Arguments that serialize are kept untouched — a sizing failure in one
 * argument must not cost the caller the rest of the log line.
 */
function retainSizeableArgs(nativeArgs: unknown[]): { args: unknown[]; bytes: number; replaced: number } {
  let bytes = 0;
  let replaced = 0;
  const args = nativeArgs.map(arg => {
    let json: string | undefined;
    try {
      json = JSON.stringify(arg);
    } catch {
      // Not silent: the caller warns once per context. Warning per occurrence
      // would let a script flood the host console (see sizingWarningShown).
      const placeholder = describeUnsizeableArg(arg);
      replaced += 1;
      bytes += placeholder.length;
      return placeholder;
    }
    bytes += json?.length ?? 0;
    return arg;
  });
  return { args, bytes, replaced };
}
