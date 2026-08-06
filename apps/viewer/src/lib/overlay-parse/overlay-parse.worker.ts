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

const EMPTY = new Float32Array(0);

function runParse(processor: GeometryProcessor, kind: OverlayParseKind, source: Uint8Array): Float32Array {
  const verts = kind === 'grid-lines'
    ? processor.parseGridLines(source)
    : processor.parseAlignmentLines(source);
  return verts && verts.length > 0 ? verts : EMPTY;
}

self.onmessage = async (event: MessageEvent<OverlayParseRequest>) => {
  const { id, kind, source } = event.data;
  const processor = new GeometryProcessor();
  try {
    await processor.init();
    const verts = runParse(processor, kind, source);
    const reply: OverlayParseResponse = { id, ok: true, verts };
    // `verts` is a fresh copy out of WASM, so transferring it is safe and
    // saves a structured clone of the vertex data.
    (self as unknown as Worker).postMessage(reply, [verts.buffer as ArrayBuffer]);
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
    // as soon as the last in-flight job settles.
    processor.dispose();
  }
};
