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
import { buildSchemaNamespaces, disposeSchemaNamespaceSession, type BridgeCallContext } from './bridge-schema.js';

/**
 * Build the `bim` API object inside the QuickJS VM.
 * Returns captured log entries from console.* calls.
 */
export function buildBridge(
  vm: QuickJSContext,
  sdk: BimContext,
  permissions: SandboxPermissions = {},
  context: BridgeCallContext,
): { logs: LogEntry[]; dispose: () => void } {
  const perms = { ...DEFAULT_PERMISSIONS, ...permissions } as Required<SandboxPermissions>;
  const logs: LogEntry[] = [];

  // ── console.log / warn / error / info ──────────────────────
  buildConsole(vm, logs);

  // ── bim global ─────────────────────────────────────────────
  const bimHandle = vm.newObject();

  // All namespaces are schema-driven (model, query, viewer, mutate, lens, export)
  buildSchemaNamespaces(vm, bimHandle, sdk, perms, context);

  vm.setProp(vm.global, 'bim', bimHandle);
  bimHandle.dispose();

  return {
    logs,
    dispose: () => {
      disposeSchemaNamespaceSession(context);
    },
  };
}

// ── Console ──────────────────────────────────────────────────

function buildConsole(vm: QuickJSContext, logs: LogEntry[]): void {
  const consoleHandle = vm.newObject();

  // vm.dump copies sandbox strings onto the host JS heap, which is NOT bound by
  // the QuickJS memoryBytes limit. Cap both entry count and cumulative
  // serialized size so an untrusted script (e.g. `for(;;) console.log('x'.repeat(1e6))`)
  // cannot exhaust host memory before the eval timeout fires.
  const MAX_LOG_ENTRIES = 1000;
  const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 4MB host budget for captured logs
  let totalBytes = 0;
  let truncated = false;

  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    const fn = vm.newFunction(level, (...args: QuickJSHandle[]) => {
      if (truncated) return;
      if (logs.length >= MAX_LOG_ENTRIES || totalBytes >= MAX_TOTAL_BYTES) {
        truncated = true;
        logs.push({ level: 'warn', args: ['[log output truncated: limit reached]'], timestamp: Date.now() });
        return;
      }
      const nativeArgs = args.map(a => vm.dump(a));
      // Approximate host cost of retaining this entry; treat unserializable
      // args (e.g. cyclic) as zero-cost rather than failing the log call.
      let entryBytes = 0;
      try {
        entryBytes = JSON.stringify(nativeArgs)?.length ?? 0;
      } catch {
        entryBytes = 0; /* unserializable args — skip cost accounting */
      }
      totalBytes += entryBytes;
      logs.push({ level, args: nativeArgs, timestamp: Date.now() });
    });
    vm.setProp(consoleHandle, level, fn);
    fn.dispose();
  }

  vm.setProp(vm.global, 'console', consoleHandle);
  consoleHandle.dispose();
}
