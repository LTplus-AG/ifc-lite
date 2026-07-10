/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU residency budget for the renderer scene (issue #1682, phase 3a).
 *
 * OFF BY DEFAULT (no eviction). Opt in per session, read once at renderer
 * init; the value is megabytes of GPU geometry the bucket batches may hold
 * before least-recently-drawn ones are evicted (and rebuilt on demand).
 * Meaningful together with spatial chunking (`__IFC_LITE_CHUNKS`) — without
 * it, batches are model-wide colour groups and everything is always
 * "recently drawn". Benchmark A/B env: VIEWER_BENCHMARK_GPU_BUDGET.
 *
 *   globalThis.__IFC_LITE_GPU_BUDGET_MB = 512   // 512 MB budget
 */
export function getGpuResidencyBudgetBytes(): number | null {
  const raw = (globalThis as { __IFC_LITE_GPU_BUDGET_MB?: unknown }).__IFC_LITE_GPU_BUDGET_MB;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw * 1024 * 1024);
}
