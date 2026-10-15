/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The one definition of "a real GPU adapter" for every native perf gate: the
// frame rig, the night trend, the #6993 count driver and the worker-pool
// lifecycle invariants. Plain .mjs so .mjs and .ts callers share it.
const SOFTWARE_RENDERER = /swiftshader|software|llvmpipe/i;

/** A renderer adapter identity that names real hardware, not a software rasterizer. */
export function isHardwareAdapter(adapter) {
  return typeof adapter?.vendor === 'string' && adapter.vendor.trim() !== ''
    && !SOFTWARE_RENDERER.test(JSON.stringify(adapter));
}
