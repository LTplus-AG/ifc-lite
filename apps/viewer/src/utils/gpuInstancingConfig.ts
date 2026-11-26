/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GEOMETRY_PERF_FLAG_BINDINGS, setGlobalInstancingRamp } from '@ifc-lite/geometry';
import type { Renderer, SceneContents } from '@ifc-lite/renderer';
import { readPerfFlagRaw } from '@ifc-lite/data';
import { getPerfFlagDefinition, resolvePerfFlag } from '../lib/perf/flags.js';
import { recordAppliedPerfFlag } from '../lib/perf/flags-applied.js';
import { isHugeGeometryEnabled, isPerfFlagOff, isPerfFlagOn, readRampFlag } from './hugeGeometryConfig.js';

/**
 * GPU-driven instancing (`@ifc-lite/renderer` gpu-instance-pool.ts), OFF by
 * default: occurrence tables, a compute cull and indirect draws instead of
 * per-template CPU culls and repacks. Read once at renderer init, before
 * instanced shards stream in:
 *   ?perf.gpuInstancing=1   or   globalThis.__IFC_LITE_GPU_INSTANCING = 1
 * When unset, the huge-geometry umbrella (`hugeGeometryConfig.ts`) decides,
 * then the `perf-gpu-instancing` PostHog ramp.
 */
export function isGpuInstancingEnabled(readFeatureFlag?: (key: string) => unknown): boolean {
  const huge = isHugeGeometryEnabled();
  const raw = readRampFlag('gpuInstancing', huge, readFeatureFlag);
  if (isPerfFlagOn(raw)) return true;
  return isPerfFlagOff(raw) ? false : huge; // unrecognised values do not override
}

/** Hand the flag to a fresh renderer before instanced shards stream in; a no-op when off. */
export function configureGpuInstancing(renderer: Pick<Renderer, 'setGpuInstancing'>): boolean {
  const on = isGpuInstancingEnabled() && renderer.setGpuInstancing(true);
  recordAppliedPerfFlag('gpuInstancing', on); // the telemetry arm is what ran
  if (on) console.log('[Viewport] GPU-driven instancing on');
  return on;
}

/**
 * The scene joins keyed instanced records (global instance plan) by default, on every upload path, so a reopen
 * draws like its cold load. An explicit `?perf.globalInstancing=0` is the kill switch for the join as well: a reopen
 * of a snapshot cached with the plan then draws one template per record, as before the plan. The `perf-global-instancing`
 * ramp does not switch the join off. Read once at init.
 */
export function configureKeyedInstancing(scene: Pick<SceneContents, 'keyedInstancing'>): boolean {
  if (!scene.keyedInstancing) return false;
  // Explicit only: a user outside the PostHog ramp reads `false` there, and must still join a plan's cached records.
  scene.keyedInstancing.enabled = !isPerfFlagOff(readPerfFlagRaw(GEOMETRY_PERF_FLAG_BINDINGS.globalInstancing));
  return scene.keyedInstancing.enabled;
}

/**
 * Let the geometry host ask the `perf-global-instancing` PostHog ramp whether the global instance plan applies,
 * when no global or URL param says so, and record what each pool load decided as the telemetry arm. Call before
 * each exact load: the arm starts off, so a small file, a non-pool load or a cache reopen reports the default
 * rather than the user's ramp value.
 */
export function installGlobalInstancingRamp(readFeatureFlag?: (key: string) => unknown): void {
  const flag = getPerfFlagDefinition('globalInstancing');
  recordAppliedPerfFlag('globalInstancing', false);
  setGlobalInstancingRamp({
    read: () => resolvePerfFlag(flag, readFeatureFlag),
    decided: (applies) => recordAppliedPerfFlag('globalInstancing', applies),
  });
}
