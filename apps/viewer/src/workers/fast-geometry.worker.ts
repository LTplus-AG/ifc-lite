/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Small-file fast path: a spare worker that meshes the picked file while the
 * main thread resets the interface.
 *
 * It makes the SAME `processAdaptive` call the loader would make
 * (`adaptiveGeometryOptions`, shared with `geometryEventSource.ts`): below 2 MiB
 * the single-session branch, from 2 MiB the worker pool with GPU instancing
 * (whose workers it spawns from here), so it emits the same events, including
 * instanced shards, `unitRefused` and `workerMemory`. What it saves is the wait:
 * it starts at the pick, reads the File itself, and its engine (and the pool's
 * shared engine module) was compiled at idle.
 *
 * Protocol (one run per worker; the host terminates it afterwards):
 *   prewarm { wasmModule, warmBytes[], settings } -> ready { warmMs, wasmMemoryBytes } | error
 *   run { file, settings, workerCountOverride }   -> event { event }* then end | error
 *   cancel                                        -> (the run stops; nothing more is posted)
 */

import { initSync } from '@ifc-lite/wasm';
import { compileSharedWasmModule, type GeometryMeshingSettings } from '@ifc-lite/geometry';
import { fastRunEvents } from './fast-geometry-run.js';

type Inbound =
  | { type: 'prewarm'; wasmModule: WebAssembly.Module; warmBytes: Uint8Array[]; settings: GeometryMeshingSettings }
  | { type: 'run'; file: Blob; settings: GeometryMeshingSettings; workerCountOverride?: number }
  | { type: 'cancel' };

const post = (message: unknown) => (self as unknown as Worker).postMessage(message);
let running: AbortController | null = null;

self.onmessage = async (event: MessageEvent<Inbound>) => {
  const message = event.data;
  if (message.type === 'cancel') { running?.abort(); return; }
  try {
    if (message.type === 'prewarm') {
      const exports = initSync({ module: message.wasmModule });
      const startedAt = performance.now();
      // The pool path compiles its own shared module in this realm; do it now, not at the pick.
      await compileSharedWasmModule();
      const idle = new AbortController();
      for (const bytes of message.warmBytes) for await (const _ of fastRunEvents(bytes, message.settings, undefined, idle.signal)) { /* warm-up only */ }
      post({ type: 'ready', warmMs: performance.now() - startedAt, wasmMemoryBytes: exports.memory.buffer.byteLength });
      return;
    }
    if (message.type === 'run') {
      const controller = new AbortController();
      running = controller;
      const bytes = new Uint8Array(await message.file.arrayBuffer());
      for await (const ev of fastRunEvents(bytes, message.settings, message.workerCountOverride, controller.signal)) {
        if (controller.signal.aborted) return;
        post({ type: 'event', event: ev });
      }
      if (!controller.signal.aborted) post({ type: 'end' });
    }
  } catch (err) {
    if (running?.signal.aborted) return;
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
