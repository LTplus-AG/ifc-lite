/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { refusedRendererSnapshot } from '../../scripts/perf/interleaved-diagnostics.js';
type SceneSnapshot = ReturnType<typeof refusedRendererSnapshot>;

/** Strict prospective scene contract for the two frozen comparison subjects. */
export function sceneSettlement(snapshot: SceneSnapshot) {
  if (!snapshot.rendererFound || snapshot.load.modelCount === 0) return null;
  if (!snapshot.traversal.complete) throw new Error('REFUSE readiness: incomplete renderer discovery');
  if (snapshot.load.error || snapshot.model.loadError) throw new Error('REFUSE readiness: load error');
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (snapshot.load.modelCount !== 1 || typeof snapshot.model.id !== 'string'
    || snapshot.load.activeModelId !== snapshot.model.id || !snapshot.model.dataStorePresent
    || typeof snapshot.load.loading !== 'boolean' || typeof snapshot.load.streaming !== 'boolean'
    || typeof snapshot.rendererReady !== 'boolean' || !snapshot.canvas
    || !count(snapshot.load.pendingInstanceShards) || !count(snapshot.load.geometryMeshes)
    || !count(snapshot.scene.batchCount) || !count(snapshot.scene.flatOwners)
    || !count(snapshot.scene.instanceOwners) || !count(snapshot.scene.instancedCount)
    || !count(snapshot.scene.gpuInstanceOccurrences)
    || [snapshot.scene.pendingBatches, snapshot.scene.queued, snapshot.scene.fragments,
      snapshot.scene.finalizing, snapshot.scene.geometryReleased].some(value => typeof value !== 'boolean')) {
    throw new Error('REFUSE readiness: unknown scene/store shape');
  }
  if (!snapshot.rendererReady || snapshot.load.loading || snapshot.load.streaming
    || snapshot.model.loadState !== 'complete' || snapshot.load.pendingInstanceShards
    || snapshot.scene.pendingBatches || snapshot.scene.queued || snapshot.scene.fragments
    || snapshot.scene.finalizing || snapshot.scene.geometryReleased
    || snapshot.canvas.width <= 0 || snapshot.canvas.height <= 0
    || !snapshot.load.geometryMeshes || !(snapshot.scene.flatOwners + snapshot.scene.instanceOwners)) return null;
  if (snapshot.scene.instancedCount !== snapshot.scene.instanceOwners
    || snapshot.scene.gpuInstanceOccurrences < snapshot.scene.instancedCount) {
    throw new Error('REFUSE readiness: incomplete instance upload census');
  }
  const frame = snapshot.frame;
  const timestamp: unknown = frame && typeof frame === 'object' ? Reflect.get(frame, 'timestamp') : null;
  const drawCalls: unknown = frame && typeof frame === 'object' ? Reflect.get(frame, 'drawCalls') : null;
  if (frame !== null && (!count(drawCalls) || typeof timestamp !== 'number' || !Number.isFinite(timestamp))) {
    throw new Error('REFUSE readiness: unknown frame shape');
  }
  const milestone = snapshot.milestones;
  if (!milestone || typeof milestone !== 'object') throw new Error('REFUSE readiness: missing producer milestones');
  const uploadMs: unknown = Reflect.get(milestone, 'uploadMs');
  const geometryMs: unknown = Reflect.get(milestone, 'geometryMs');
  const metadataMs: unknown = Reflect.get(milestone, 'metadataMs');
  if (Reflect.get(milestone, 'error') || Reflect.get(milestone, 'uploadCount') !== 1
    || [uploadMs, geometryMs, metadataMs].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    || Number(geometryMs) < Number(uploadMs) || Number(metadataMs) < Number(uploadMs)) {
    throw new Error('REFUSE readiness: invalid producer milestones');
  }
  return { uploadMs: Number(uploadMs), geometryMs: Number(geometryMs),
    frameMs: snapshot.debugFrameMatches && typeof drawCalls === 'number' && drawCalls > 0 ? timestamp : null };
}

/** Canonical load-time failures only; analytics and host warnings are unrelated. */
export function assertNoViewerLoadFailures(logs: readonly string[]): void {
  if (logs.some(log => /\[useIfc\].*(?:metadata|Data model) (?:parse|parsing) failed/i.test(log))) {
    throw new Error('Metadata failed before metadata/render readiness');
  }
  if (logs.some(log => /\[Viewport\] Renderer init failed|finalizeStreamingAsync failed/.test(log)
    || /\[(?:Viewport|Renderer)\] GPU device lost|\[WebGPU\] (?:Device lost|Uncaptured error|Validation error|popErrorScope rejected|Failed to configure context)/.test(log)
    || /\[gpu\].* failed|\[useGeometryStreaming\] instanced shard upload failed/.test(log))) {
    throw new Error('Renderer failed before metadata/render readiness');
  }
}

/** The same fault policy guards completion and the final pre-close receipt. */
export function guardViewerCompletion<T>(logs: readonly string[], eligible: () => T,
  refuse: (error: unknown) => T): T {
  try { assertNoViewerLoadFailures(logs); }
  catch (error) { return refuse(error); }
  return eligible();
}

/** Prospective log+settled-scene+fresh CPU frame boundary; no GPU completion claim. */
export async function waitForMetadataRenderReadiness(options: {
  logs: () => readonly string[];
  sceneSnapshot: () => Promise<SceneSnapshot>;
  now: () => number;
  pause: () => Promise<void>;
  timeoutMs: number;
}): Promise<number> {
  const start = options.now();

  while (options.now() - start < options.timeoutMs) {
    const logs = options.logs();
    assertNoViewerLoadFailures(logs);
    const metadata = logs.some(log => /\[useIfc\] (?:Native )?(?:metadata|Data model) (?:parse|parsing) complete/i.test(log));
    const geometry = logs.some(log => /\[useIfc\] (?:Native )?(?:Stream complete|Geometry streaming complete)/i.test(log));
    if (metadata && geometry) {
      const witness = sceneSettlement(await options.sceneSnapshot());
      if (witness && typeof witness.frameMs === 'number'
        && witness.frameMs > witness.uploadMs && witness.frameMs >= witness.geometryMs) return options.now();
    }

    await options.pause();
  }
  throw new Error('Timed out awaiting metadata, geometry, settled scene and fresh frame; sample incomplete');
}
