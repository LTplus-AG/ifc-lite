/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU residency budget for the renderer scene (issue #1682, phase 3a).
 *
 * DEFAULT 2048 MB since the #1682 sweep: a generous target that is a no-op
 * on ordinary models (they never exceed it) and bounds the #1682-class
 * monsters. Over-budget is safe by design — visible batches are never
 * evicted, rendering is unaffected, the budget is a target not a cap.
 * Kill switch: set 0. Benchmark A/B env: VIEWER_BENCHMARK_GPU_BUDGET.
 *
 *   globalThis.__IFC_LITE_GPU_BUDGET_MB = 512   // custom budget
 *   globalThis.__IFC_LITE_GPU_BUDGET_MB = 0     // off
 */
const DEFAULT_GPU_BUDGET_MB = 2048;

export function getGpuResidencyBudgetBytes(): number | null {
  const raw = (globalThis as { __IFC_LITE_GPU_BUDGET_MB?: unknown }).__IFC_LITE_GPU_BUDGET_MB;
  if (raw === undefined || raw === null) return DEFAULT_GPU_BUDGET_MB * 1024 * 1024;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  const bytes = Math.round(raw * 1024 * 1024);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

/**
 * HOST (CPU) residency budget for bucket geometry (issue #1682 phase 3b).
 * DEFAULT 3072 MB (a no-op below that; bounds the monsters). Only effective
 * on v13-cached models (the cold tier needs a disk restore source) and
 * together with the GPU budget (only GPU-evicted buckets are cold-eligible).
 * Kill switch: set 0. Benchmark A/B env: VIEWER_BENCHMARK_HOST_BUDGET.
 *
 *   globalThis.__IFC_LITE_HOST_BUDGET_MB = 1024   // custom
 *   globalThis.__IFC_LITE_HOST_BUDGET_MB = 0      // off
 */
const DEFAULT_HOST_BUDGET_MB = 3072;

export function getHostResidencyBudgetBytes(): number | null {
  const raw = (globalThis as { __IFC_LITE_HOST_BUDGET_MB?: unknown }).__IFC_LITE_HOST_BUDGET_MB;
  if (raw === undefined || raw === null) return DEFAULT_HOST_BUDGET_MB * 1024 * 1024;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  const bytes = Math.round(raw * 1024 * 1024);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}
