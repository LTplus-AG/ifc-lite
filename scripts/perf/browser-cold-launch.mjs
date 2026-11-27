/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** browser-cold-ab's historical WebGPU flags, kept unchanged for runs without a host GPU launch. */
export const DEFAULT_COLD_AB_GPU_ARGS = Object.freeze(['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist']);

/**
 * Chrome launch flags for `browser-cold-ab.mts`. `IFC_GPU_CHROME_ARGS` (what
 * `ifc-gpu-check` exports, e.g. Pop's Vulkan launch for chrome-headless-shell)
 * replaces the defaults, plus the high-performance adapter pin: headless
 * Chrome on Pop otherwise gets SwiftShader or the integrated GPU, and a timing
 * A/B there measures the wrong device. The defaults stay unpinned, so a run
 * without the host variable launches exactly as before.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function coldAbBrowserArgs(env) {
  const fromHost = (env.IFC_GPU_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
  return fromHost.length ? [...fromHost, '--use-webgpu-power-preference=default-high-performance'] : [...DEFAULT_COLD_AB_GPU_ARGS];
}
