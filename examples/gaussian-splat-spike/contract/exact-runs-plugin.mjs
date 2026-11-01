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
    if (id.replaceAll('\\', '/').endsWith('/webgpu/dist/adapter/webgpu-device.js')) {
      const original = await readFile(id, 'utf8');
      if (createHash('sha256').update(original).digest('hex') !== '16a5e6130a345a871d2f4c29374e40d76d4a1219b38cb13a6c13a8c9dc6712a9') throw new Error('Unqualified WebGPU device');
      // Restricted offscreen borrowing backport; current upstream already owns this contract.
      return { code: original.replace('this.handle = device;', 'this.handle = device; this.contractOwnsDevice = props.contractOwnsDevice !== false;')
        .replace('this.handle.destroy();', 'if (this.contractOwnsDevice) this.handle.destroy();'), map: null };
    }
    if (!id.replaceAll('\\', '/').endsWith('/splats/dist/splat-renderer.js')) return;
    const original = await readFile(id, 'utf8');
    if (createHash('sha256').update(original).digest('hex') !== publishedRendererHash) {
      throw new Error('Unqualified upstream renderer revision');
    }
    let code = patchDepthConvention(original);
    // Upstream Model syncs attachment formats but not sample count. Reuse its
    // parameter path; no Gaussian shader change or new rasterizer is involved.
    code = code.replace("return this.device.type === 'webgpu'\n            ? this.drawWebGPUStorageRuns(renderPass)",
      "this.model.setParameters({...this.model.parameters, sampleCount: renderPass.framebuffer.colorAttachments[0].texture.props.samples});\n        return this.device.type === 'webgpu'\n            ? this.drawWebGPUStorageRuns(renderPass)");
    if (exact) {
      code = code.replace('const MAX_EXACT_SPLAT_DRAW_RUNS = 64;', 'const MAX_EXACT_SPLAT_DRAW_RUNS = 128;');
      // Reject before rebuildDrawRuns detaches the old buffers. An exhausted
      // update must leave them reachable by destroy(), including on scene edits.
      code = code.replace('rebuildDrawRuns() {', `rebuildDrawRuns() {
        let contractRuns = 0, contractPreviousBatch = -1;
        for (const reference of this.sortedReferences) {
          if (reference.batchIndex !== contractPreviousBatch) {
            contractPreviousBatch = reference.batchIndex;
            if (++contractRuns > 128) throw new Error('Exact source-run budget exceeded (128)');
          }
        }`);
    }
    return { code, map: null };
  } };
}
