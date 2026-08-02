/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 12-byte lattice-quantized batch vertices (issue #1682, phase 6).
 *
 * ON BY DEFAULT since the flip sweep: GPU resident bytes -37% to -45%
 * (FZK 1.1->0.6 MB, DigitalHub 20.2->12.7 MB, advanced_model 37.5->22.2 MB)
 * with load KPIs and draw calls unchanged and pixel deltas <= 0.007%,
 * including live selection (hydrated highlight meshes lattice-snap to stay
 * bit-coincident with their quantized source batch). The renderer probes its
 * quantized pipelines (async WebGPU validation) before the scene may produce
 * 12B buffers, and batches exceeding the 64 m lattice range fall back to
 * f32 per batch.
 *
 * Kill switch (read once at renderer init; benchmark env
 * VIEWER_BENCHMARK_QUANTIZED): globalThis.__IFC_LITE_QUANTIZED = 0
 */
export function isQuantizedEnabled(): boolean {
  const raw = (globalThis as { __IFC_LITE_QUANTIZED?: unknown }).__IFC_LITE_QUANTIZED;
  if (raw === undefined || raw === null) return true;
  return raw === 1 || raw === true;
}
