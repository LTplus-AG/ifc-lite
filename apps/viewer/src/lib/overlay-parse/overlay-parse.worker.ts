/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Worker host for the always-on overlay parses that need the WHOLE IFC
 * source (issue #2183).
 *
 * `parseGridLines` / `parseAlignmentLines` take the entire file, decode it
 * to a JS string, and hand that string to WASM. Two costs of that are
 * permanent in whichever realm runs it:
 *
 *   1. `safeUtf8Decode`'s scratch buffer, when the runtime rejects
 *      SAB-backed views (every cross-origin-isolated browser). Capped
 *      since #2183, but still a full-size transient.
 *   2. `WebAssembly.Memory`, which only ever grows. `dispose()` frees the
 *      wasm-bindgen handle, not the pages.
 *
 * Run on the main thread that is ~950 MB pinned for a 342 MB model, for
 * the lifetime of the tab, to draw some overlay lines. Both costs are
 * realm-local, so hosting the parse in a worker that is terminated
 * afterwards returns all of it to the OS.
 *
 * The source is a `SharedArrayBuffer`-backed view, so handing it over is
 * zero-copy: it is shared, never cloned or transferred.
 */

import { GeometryProcessor } from '@ifc-lite/geometry';
import { buildParseReply } from './reply.js';

/** Parse kinds this worker can run. Both return a flat line-list. */
export type OverlayParseKind = 'grid-lines' | 'alignment-lines';

export interface OverlayParseRequest {
  id: number;
  kind: OverlayParseKind;
  source: Uint8Array;
}

export type OverlayParseResponse =
  | { id: number; ok: true; verts: Float32Array }
  | { id: number; ok: false; error: string };

function runParse(
  processor: GeometryProcessor,
  kind: OverlayParseKind,
  source: Uint8Array,
): Float32Array | null {
  return kind === 'grid-lines'
    ? processor.parseGridLines(source)
    : processor.parseAlignmentLines(source);
}

/**
 * Serialises message handling.
 *
 * Two jobs arriving in the same tick (a model with both grids and alignments)
 * would otherwise both `await processor.init()` concurrently. `IfcLiteBridge`
 * guards on a PER-INSTANCE flag and wasm-bindgen's `__wbg_init` guards on a
 * module-level `wasm` binding that is only assigned AFTER its await, so both
 * pass both guards and the ~3.9 MB module is instantiated twice — two
 * `WebAssembly.Memory`s in a worker whose entire purpose is to bound memory.
 * In the worker the module is always cold, so this is the normal path.
 *
 * `runParse` is fully synchronous, so serialising costs nothing: the only
 * concurrency ever available here was the init overlap.
 */
let queue: Promise<void> = Promise.resolve();

/**
 * Indirection purely so a test can force the one failure the client cannot
 * recover from cheaply: the processor failing to be constructed at all.
 * Production always uses the default.
 */
let createProcessor = (): GeometryProcessor => new GeometryProcessor();

/** Tests only. Pass null to restore the real factory. */
export function __setProcessorFactoryForTest(factory: (() => GeometryProcessor) | null): void {
  createProcessor = factory ?? ((): GeometryProcessor => new GeometryProcessor());
}

export async function handle(event: MessageEvent<OverlayParseRequest>): Promise<void> {
  const { id, kind, source } = event.data;
  // Constructed INSIDE the try. If it threw outside, the rejection would
  // escape into the queue's catch, no reply would ever be posted, and the
  // client would sit on its 120s deadline instead of failing immediately.
  let processor: GeometryProcessor | undefined;
  try {
    processor = createProcessor();
    await processor.init();
    // `verts` is a fresh JS-heap copy out of WASM (`js_sys::Float32Array::from`
    // over a Rust slice), not a view into linear memory, so transferring it is
    // safe and saves a structured clone of the vertex data.
    const { reply, transfer } = buildParseReply(id, runParse(processor, kind, source));
    (self as unknown as Worker).postMessage(reply, transfer);
  } catch (error) {
    const reply: OverlayParseResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(reply);
  } finally {
    // Frees the wasm-bindgen handle. The linear memory itself only goes
    // back to the OS when this worker is terminated, which the client does
    // as soon as the last in-flight job settles. Optional call: construction
    // itself can fail, and then there is nothing to dispose.
    processor?.dispose();
  }
}

/**
 * True only in a real dedicated-worker scope. Guarding the registration keeps
 * this module importable from a test (Node has no `self`) and off `window` if
 * it is ever pulled into a main-thread chunk.
 */
const isWorkerScope =
  typeof self !== 'undefined' &&
  typeof (globalThis as { window?: unknown }).window === 'undefined' &&
  typeof (self as unknown as Worker).postMessage === 'function';

if (isWorkerScope) {
  self.onmessage = (event: MessageEvent<OverlayParseRequest>) => {
    // `handle` never rejects (it posts an error reply instead), but chain
    // defensively so one bad job cannot poison the queue for later ones.
    queue = queue.then(() => handle(event)).catch(() => undefined);
  };
}
