/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The global instance plan's messages between the worker pool and its workers
 * (`?perf.globalInstancing=1`, off by default).
 *
 * With the flag on, the streaming pre-pass plans repeated content once for the
 * model (`setGlobalKeyPlanning`) and ships each job's plan index with its
 * chunk; the pool forwards the planned (job, index) pairs to every worker
 * through the setup log (so a replacement worker receives them too), and the
 * prepass columns carry the model-wide mapped-item counts. Each worker arms
 * the plan on its engine (`setGlobalInstancePlan`, `addGlobalKeyPlan`) and
 * re-arms it whenever it rebuilds its engine. An engine without these entry
 * points simply never arms: the batch keeps its per-batch decision.
 */

import type { IfcAPI } from '@ifc-lite/wasm';
import { globalInstancingApplies } from './perf-flags.js';

/** Unplanned job (the pre-pass's `KEY_PLAN_NONE`). */
const KEY_PLAN_NONE = 0xffff_ffff;

/** Planned jobs of one `jobs` chunk, sent to every worker. */
export interface GeometryWorkerAddKeyPlanMessage {
  type: 'add-key-plan';
  jobIds: Uint32Array;
  planIndex: Uint32Array;
}

/** The prepass-columns fields the plan adds. */
export interface GlobalPlanColumns {
  /** Arm the global instance plan for this load. */
  globalInstancing?: boolean;
  /** Model-wide IfcMappedItem count per `mappedInstancePlan` entry. */
  mappedInstanceCounts?: Uint32Array;
  mappedInstancePlan?: Uint32Array;
}

/** The engine entry points the plan uses; optional so an older engine degrades to no plan. */
export interface GlobalPlanApi {
  setGlobalInstancePlan?: (sourceIds: Uint32Array, counts: Uint32Array) => void;
  addGlobalKeyPlan?: (jobIds: Uint32Array, planIndex: Uint32Array) => void;
  setGlobalKeyPlanning?: (on: boolean) => void;
}

/**
 * Narrow wrapper for the pre-pass column setters (issue #957 / #563). Optional
 * so a staged/older engine binary without them degrades to the byte-identical
 * lazy per-worker rebuild instead of throwing. Includes the global plan's
 * entry points ({@link GlobalPlanApi}).
 */
export type IfcAPIWithPrepassColumns = IfcAPI & GlobalPlanApi & {
  setReferencedRepmaps?: (ids: Uint32Array) => void;
  setInstantiatedTypeIds?: (ids: Uint32Array) => void;
  /** #1623 Phase 3: install the don't-bake plan (RepresentationMap ids repeated
   *  >= 2x). Optional so an older engine binary degrades to full materialize. */
  setMappedInstancePlan?: (ids: Uint32Array) => void;
  setMaterialLayerIndex?: (
    elementIds: Uint32Array,
    axis: Uint32Array,
    layerCounts: Uint32Array,
    directionSense: Float64Array,
    offset: Float64Array,
    layerMaterialIds: Uint32Array,
    layerThicknesses: Float64Array,
  ) => void;
};

/** The pre-pass request field that asks it to plan content keys. */
export interface GlobalKeyPlanningField {
  globalInstancing?: boolean;
}

/** Field for the pre-pass request: plan content keys when the plan applies. */
export function globalKeyPlanningField(byteLength: number): GlobalKeyPlanningField {
  return globalInstancingApplies(byteLength) ? { globalInstancing: true } : {};
}

/** Prepass-columns fields for the workers: the counts when the plan applies and they match the plan. */
export function globalPlanColumns(evt: Record<string, unknown>, byteLength: number): GlobalPlanColumns {
  const plan = evt.mappedInstancePlan as Uint32Array | undefined;
  const counts = evt.mappedInstanceCounts as Uint32Array | undefined;
  if (!globalInstancingApplies(byteLength) || !plan || !counts || counts.length !== plan.length) return {};
  return { globalInstancing: true, mappedInstanceCounts: counts.slice() };
}

/** The planned (job, index) pairs of one `jobs` chunk, or null when it has none. */
export function plannedJobs(jobs: Uint32Array, planIndex: unknown): { jobIds: Uint32Array; planIndex: Uint32Array } | null {
  if (!(planIndex instanceof Uint32Array) || planIndex.length * 3 !== jobs.length) return null;
  const ids: number[] = [];
  const index: number[] = [];
  for (let j = 0; j < planIndex.length; j++) {
    if (planIndex[j] !== KEY_PLAN_NONE) {
      ids.push(jobs[j * 3]);
      index.push(planIndex[j]);
    }
  }
  return ids.length > 0 ? { jobIds: Uint32Array.from(ids), planIndex: Uint32Array.from(index) } : null;
}

/** Forward a chunk's planned jobs to every worker (through the pool's setup log). */
export function forwardKeyPlan(broadcast: (setup: (w: Worker) => void) => void, jobs: Uint32Array, planIndex: unknown): void {
  const planned = plannedJobs(jobs, planIndex);
  if (!planned) return;
  broadcast((w) => {
    const message: GeometryWorkerAddKeyPlanMessage = { type: 'add-key-plan', jobIds: planned.jobIds.slice(), planIndex: planned.planIndex.slice() };
    w.postMessage(message, [message.jobIds.buffer, message.planIndex.buffer]);
  });
}

/**
 * A worker's copy of the plan: the columns' mapped plan plus every key-plan
 * chunk received this load, re-applied to each engine the worker builds.
 * Cleared with the pre-pass columns (content swap, stream end).
 */
export class WorkerGlobalPlan {
  private chunks: GeometryWorkerAddKeyPlanMessage[] = [];
  /** Whether the current engine was armed by {@link apply}. */
  private armed = false;
  private warned = false;

  /** Arm `api` from the columns, then replay the key plan. No-op when the columns did not arm the plan. */
  apply(api: GlobalPlanApi, columns: GlobalPlanColumns): void {
    this.armed = !!columns.globalInstancing && !!columns.mappedInstancePlan && !!columns.mappedInstanceCounts
      && typeof api.setGlobalInstancePlan === 'function' && typeof api.addGlobalKeyPlan === 'function';
    if (columns.globalInstancing && !this.armed && !this.warned) {
      // Flag on, plan not armed: say why once per load rather than fall back silently.
      this.warned = true;
      const engine = typeof api.setGlobalInstancePlan === 'function' && typeof api.addGlobalKeyPlan === 'function';
      console.warn(engine
        ? '[Worker] global instance plan requested but the pre-pass columns carry no mappedInstanceCounts; keeping per-batch instancing'
        : '[Worker] global instance plan requested but this engine lacks setGlobalInstancePlan/addGlobalKeyPlan; keeping per-batch instancing');
    }
    if (!this.armed || !columns.mappedInstancePlan || !columns.mappedInstanceCounts) return;
    api.setGlobalInstancePlan?.(columns.mappedInstancePlan, columns.mappedInstanceCounts);
    for (const chunk of this.chunks) api.addGlobalKeyPlan?.(chunk.jobIds, chunk.planIndex);
  }

  /** Record a key-plan chunk, installing it at once on an armed engine. */
  record(api: GlobalPlanApi | null, chunk: GeometryWorkerAddKeyPlanMessage): void {
    this.chunks.push(chunk);
    if (api && this.armed) api.addGlobalKeyPlan?.(chunk.jobIds, chunk.planIndex);
  }

  clear(): void {
    this.chunks = [];
    this.armed = false;
    this.warned = false;
  }
}
