/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Small-file fast path: one spare worker that meshes a whole small model in a
 * single engine session and posts every geometry event back in one message.
 *
 * It runs the same single-session path the main thread uses for small files
 * (`processAdaptive`'s synchronous branch: pre-pass, then one geometry batch
 * over every job), so per-element output is the same as the pool's. What it
 * saves is set-up: no pool handshake, no pre-pass round trip, no worker spawn
 * or engine instantiation after the pick (the host does those at idle), and
 * the File is read here, in parallel with the interface reset on main.
 *
 * Protocol (one run per worker; the host terminates it afterwards):
 *   prewarm { wasmModule, warmBytes[], settings } -> ready { warmMs, wasmMemoryBytes } | error
 *   run { file, settings }                        -> result { events } | error
 */

import { initSync } from '@ifc-lite/wasm';
import { GeometryProcessor, type GeometryMeshingSettings, type StreamingGeometryEvent } from '@ifc-lite/geometry';

type Inbound =
  | { type: 'prewarm'; wasmModule: WebAssembly.Module; warmBytes: Uint8Array[]; settings: GeometryMeshingSettings }
  | { type: 'run'; file: Blob; settings: GeometryMeshingSettings };

async function mesh(bytes: Uint8Array, settings: GeometryMeshingSettings): Promise<StreamingGeometryEvent[]> {
  const processor = new GeometryProcessor({
    preferNative: false,
    mergeLayers: settings.mergeLayers,
    enableInstancing: settings.enableInstancing,
    tessellationQuality: settings.tessellationQuality ?? undefined,
    skipSmallCuts: settings.skipSmallCuts,
    skipVoids: settings.skipVoids,
  });
  try {
    await processor.init();
    if (settings.geometryHashTolerance !== null) processor.enableGeometryHashes(settings.geometryHashTolerance);
    const events: StreamingGeometryEvent[] = [];
    // A threshold above any input keeps processAdaptive on its single-session branch.
    for await (const event of processor.processAdaptive(bytes, { sizeThreshold: Number.MAX_SAFE_INTEGER })) events.push(event);
    return events;
  } finally {
    processor.dispose();
  }
}

const post = (message: unknown) => (self as unknown as Worker).postMessage(message);

self.onmessage = async (event: MessageEvent<Inbound>) => {
  const message = event.data;
  try {
    if (message.type === 'prewarm') {
      const exports = initSync({ module: message.wasmModule });
      const startedAt = performance.now();
      for (const bytes of message.warmBytes) await mesh(bytes, message.settings);
      post({ type: 'ready', warmMs: performance.now() - startedAt, wasmMemoryBytes: exports.memory.buffer.byteLength });
      return;
    }
    if (message.type === 'run') {
      const bytes = new Uint8Array(await message.file.arrayBuffer());
      const events = await mesh(bytes, message.settings);
      post({ type: 'result', events });
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
