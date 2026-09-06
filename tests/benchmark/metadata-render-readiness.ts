/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Manual log+canvas-allocation boundary; no WebGPU pixel-readback claim (#3978). */
export async function waitForMetadataRenderReadiness(options: {
  logs: () => readonly string[];
  canvasReady: () => Promise<boolean>;
  now: () => number;
  pause: () => Promise<void>;
  timeoutMs: number;
}): Promise<number> {
  const start = options.now();
  while (options.now() - start < options.timeoutMs) {
    const logs = options.logs();
    if (logs.some(log => /\[useIfc\].*(?:metadata|Data model) (?:parse|parsing) failed/i.test(log))) {
      throw new Error('Metadata failed before metadata/render readiness');
    }
    const metadata = logs.some(log => /\[useIfc\] (?:Native )?(?:metadata|Data model) (?:parse|parsing) complete/i.test(log));
    const geometry = logs.some(log => /\[useIfc\] (?:Native )?(?:Stream complete|Geometry streaming complete)/i.test(log));
    if (logs.some(log => /\[Viewport\] Renderer init failed|finalizeStreamingAsync failed/.test(log))) {
      throw new Error('Renderer failed before metadata/render readiness');
    }
    const renderer = logs.some(log => /\[GeomStream\] finalizeStreamingAsync complete:/.test(log));
    if (metadata && geometry && renderer && await options.canvasReady()) return options.now();
    await options.pause();
  }
  throw new Error('Timed out awaiting metadata, geometry, renderer log and allocated canvas; sample incomplete');
}
