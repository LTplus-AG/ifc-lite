/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict manual-harness boundary; deliberately excludes search/cache/memory (#3978). */
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
    const renderer = logs.some(log => /\[useIfc\] TOTAL LOAD TIME|\[useIfc\].*meshes.*first:.*total:|\[ifc-lite\].*→\s*\d[\d,]*\s*meshes.*in\s*[\d.]+s/.test(log));
    if (metadata && geometry && renderer && await options.canvasReady()) return options.now();
    await options.pause();
  }
  throw new Error('Timed out awaiting metadata, geometry and rendered canvas; sample incomplete');
}
