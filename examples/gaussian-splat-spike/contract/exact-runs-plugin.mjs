/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { patchDepthConvention, publishedRendererHash } from '../depth-patch.mjs';

// Research only: reuse the upstream sorter, buffers, shaders and draw loop.
// Fail closed above the experiment's budget; never silently approximate order.
export function exactRunsPlugin(exact) {
  return { name: 'bounded-exact-source-runs-8564', enforce: 'pre', async load(id) {
    if (!id.replaceAll('\\', '/').endsWith('/splats/dist/splat-renderer.js')) return;
    const original = await readFile(id, 'utf8');
    if (createHash('sha256').update(original).digest('hex') !== publishedRendererHash) {
      throw new Error('Unqualified upstream renderer revision');
    }
    let code = patchDepthConvention(original);
    if (exact) {
      code = code.replace('const MAX_EXACT_SPLAT_DRAW_RUNS = 64;', 'const MAX_EXACT_SPLAT_DRAW_RUNS = 128;');
      const marker = 'if (exactRunCount > MAX_EXACT_SPLAT_DRAW_RUNS) {';
      const second = code.indexOf(marker, code.indexOf(marker) + marker.length);
      if (second < 0) throw new Error('Missing upstream approximation branch');
      code = code.slice(0, second) + code.slice(second).replace(marker,
        marker + "\n throw new Error('Exact source-run budget exceeded (128)');");
    }
    return { code, map: null };
  } };
}
