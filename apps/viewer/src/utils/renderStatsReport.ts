/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Post-load render/memory telemetry (issue #1682 observability).
 *
 * Fired once per model load, AFTER the scene settles (mesh queue drained and
 * streaming fragments merged into final batches), so the numbers describe the
 * steady state the user actually keeps, not a mid-stream snapshot. Emits one
 * console line (parsed by tests/benchmark/viewer-benchmark-page.ts — keep the
 * format in sync) and one PostHog event.
 */

import { getGlobalRenderer } from '../hooks/useBCF.js';
import { posthog } from '../lib/analytics.js';

/** Max time to wait for the scene to settle before reporting anyway. */
const SETTLE_TIMEOUT_MS = 60_000;
const SETTLE_POLL_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for a fresh frame; falls back to a timer when rAF is throttled (hidden tab). */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 300);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Report steady-state render stats for the current scene. Fire-and-forget:
 * never throws, no-ops when the renderer is unavailable (headless loads).
 *
 * Numbers are scene-wide: on a federated load they cover ALL loaded models,
 * which is the right shape for "what is this tab holding" telemetry.
 *
 * `isStale` lets the caller cancel a superseded report (a newer load started
 * while this one was settling): a stale reporter exits silently — the newer
 * load's own reporter emits the definitive line for the current scene.
 */
export async function reportRenderStats(context: {
  fileName: string;
  fileSizeMB: number;
  isStale?: () => boolean;
}): Promise<void> {
  try {
    const renderer = getGlobalRenderer();
    if (!renderer) {
      // Keep the line present in every load's console stream so log parsers
      // (benchmark harness) never wait for a report that cannot come.
      console.log('[ifc-lite] render stats: unavailable (no renderer)');
      return;
    }
    const scene = renderer.getScene();

    const deadline = performance.now() + SETTLE_TIMEOUT_MS;
    while (
      (scene.hasQueuedMeshes() || scene.hasStreamingFragments()) &&
      performance.now() < deadline
    ) {
      if (context.isStale?.()) return;
      await sleep(SETTLE_POLL_MS);
    }
    if (context.isStale?.()) return;

    // Ensure the stats snapshot reflects the settled scene: request a frame
    // and give the animation loop two ticks to render it.
    renderer.requestRender();
    await nextFrame();
    await nextFrame();
    if (context.isStale?.()) return;

    const stats = renderer.getFrameStats();
    if (!stats) {
      // No frame ever completed (e.g. WebGPU init failed in headless CI).
      console.log('[ifc-lite] render stats: unavailable (no completed frame)');
      return;
    }
    const gpu = scene.getResidentGpuBytes();
    const gpuMB = gpu.total / (1024 * 1024);

    console.log(
      `[ifc-lite] render stats: ${stats.drawCalls} draw calls, ` +
      `${gpuMB.toFixed(1)} MB GPU resident ` +
      `(${stats.batchesDrawn} batches drawn, ${stats.batchesFrustumCulled} frustum-culled, ` +
      `${stats.batchesContributionCulled} contribution-culled)`
    );
    posthog.capture('viewer_render_stats', {
      file_size_mb: Math.round(context.fileSizeMB * 100) / 100,
      draw_calls: stats.drawCalls,
      resident_gpu_mb: Math.round(gpuMB * 10) / 10,
      resident_gpu_batches_mb: Math.round((gpu.batches / (1024 * 1024)) * 10) / 10,
      resident_gpu_instanced_mb: Math.round((gpu.instanced / (1024 * 1024)) * 10) / 10,
      batches_drawn: stats.batchesDrawn,
      batches_frustum_culled: stats.batchesFrustumCulled,
      batches_contribution_culled: stats.batchesContributionCulled,
    });
  } catch (err) {
    // Telemetry must never break a load.
    console.warn('[ifc-lite] render stats capture failed:', err);
  }
}
