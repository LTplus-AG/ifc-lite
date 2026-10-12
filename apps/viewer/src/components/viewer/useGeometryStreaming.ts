/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { flushPlacementGeometry } from '@/lib/model-placement/bounds-revision';
/**
 * Geometry streaming hook for the 3D viewport.
 *
 * Responsibilities:
 *   1. Detect new / incremental / cleared geometry and manage scene state.
 *   2. During streaming: queue meshes via scene.queueMeshes() (instant, no GPU).
 *      The animation loop drains the queue each frame with a time budget.
 *   3. On streaming complete: time-sliced finalize + bounds refit.
 *   4. Camera fitting (initial + post-stream refit).
 *   5. Color update effects (mesh recolor + lens overlays).
 *
 * This hook NEVER calls renderer.render() directly.  All render scheduling
 * goes through renderer.requestRender(), and the single animation loop
 * issues the actual render() call.
 */

import { useEffect, useRef } from 'react';
import type { MeshData, DecodedInstance } from '@ifc-lite/geometry';
import { decodeInstancedShard } from '@ifc-lite/geometry';
import { NOOP_LOAD_TRACE } from '@ifc-lite/load-trace';
import { toast } from '../ui/toast.js';
import { reshapeSceneKeepingPresentInstanced } from './geometry-rebuild';
import { runGpuUpload } from './gpu-upload-guard';
import { geometryMeshKey } from './geometry-mesh-key';
import { createRobustFitBoundsAccumulator } from './robustFitBoundsAccumulator.js';
import { liftNewInstancedOccurrences, placeNewMeshesAtCurrentLevel } from '@/lib/level-arrival';
import { useColorOverlaySync } from './useColorOverlaySync.js';
import { useMeshEditDrain } from './useMeshEditDrain.js';
import { invalidateLandXmlGpuOwnershipAfterSceneClear, takeLandXmlGpuUploaded } from '../../hooks/ingest/landXmlGpuOwnership.js';
import { computeBounds, type Bounds } from './streamingBounds.js';
import { activeLoadTrace, tracePhaseOnce } from '@/lib/perf/activeLoadTrace';

let linearFitHintShown = false;

/**
 * The instanced half of "every express id is global": re-home, in place, the
 * ids each occurrence of a decoded IFNS shard carries onto its owning model's
 * global id space. The flat half, `applyFederationOffsetToMesh` in
 * `hooks/useIfcLoader.ts`, carries the reasoning and the absence rules; the two
 * must move together because `Scene.getInstancedMeshDataPieces` materializes an
 * occurrence into a `MeshData` and stamps `itemId` onto its `geometryItemId`,
 * so a shard left in local space feeds the flat field a local number.
 *
 * Typed to the one field it touches rather than to `DecodedInstancedShard`, so
 * a header field added to the wire format does not become part of this
 * function's contract, or of every fixture that exercises it.
 */
export function applyFederationOffsetToShard(
  shard: { instances: DecodedInstance[] },
  idOffset: number,
): void {
  if (idOffset <= 0) return;
  for (const instance of shard.instances) {
    instance.entityId = instance.entityId + idOffset;
    if (typeof instance.itemId === 'number') {
      instance.itemId = instance.itemId + idOffset;
    }
  }
}

import { refitCompletedStreamBounds } from './streamingCompletionBounds.js';
import { usePlacementMutationDrain } from './usePlacementMutationDrain.js';
import { useFinalizationRecoveryWake } from './useFinalizationRecoveryWake.js';
import type { UseGeometryStreamingParams } from './geometry-streaming-params.js';
export type { UseGeometryStreamingParams } from './geometry-streaming-params.js';

// Default bounds used when geometry is cleared
const DEFAULT_BOUNDS = {
  min: { x: -100, y: -100, z: -100 },
  max: { x: 100, y: 100, z: 100 },
};

// Outlier-robust camera-fit bounds (issue #1394). A handful of far-flung
// meshes (a stray covering 600 m off, a detached out-building) blow the raw
// AABB out to hundreds of metres even though ~99 % of the geometry sits in a
// compact cluster. The camera fits to the inflated AABB → its centre lands in
// empty space between the building and the strays → the model renders tiny and
// off to one side, and orbiting (the raycast-miss pivot also anchors to that
// AABB centre, see useMouseControls) swings it straight out of frame. The
// implementation (and its incremental accumulator, which avoids re-scanning
// every already-processed mesh's vertices on every streaming commit — see
// PERF note at the call sites below) lives in ./robustFitBoundsAccumulator.js.

function traceGeometrySync(message: string): void {
  console.log(`[GeomSync] ${message}`);
}

export function useGeometryStreaming(params: UseGeometryStreamingParams): void {
  const {
    rendererRef,
    isInitialized,
    gpuRecoveryEpoch = 0,
    geometry,
    geometryVersion,
    geometryReplacementVersion = 0,
    appearanceSourceGeometry,
    geometryContentVersion,
    coordinateInfo,
    isStreaming,
    modelCount = 0,
    geometryBoundsRef,
    pendingMeshColorUpdates,
    pendingColorUpdates,
    pendingMeshRemovals,
    pendingMeshTranslations,
    pendingMeshRotations,
    pendingInstancedShards,
    currentLevelY,
    modelIdToIndex,
    modelIdToOffset,
    presentInstancedModelIndices,
    clearPendingMeshColorUpdates,
    clearPendingColorUpdates,
    clearPendingMeshRemovals,
    pruneGeometryMeshes,
    clearPendingMeshTranslations,
    clearPendingMeshRotations,
    clearInstancedShards,
    releaseGeometryAfterFinalize = false,
    onGeometryReleased,
  } = params;

  const [finalizeWake, wakeAfterFailure] = useFinalizationRecoveryWake(gpuRecoveryEpoch);
  const processedMeshIdsRef = useRef<Set<string>>(new Set());
  const lastGeometryLengthRef = useRef(0);
  const lastGeometryRef = useRef<MeshData[] | null>(null);
  const lastReplacementVersionRef = useRef(geometryReplacementVersion);
  const cameraFittedRef = useRef(false);
  const robustFitAccRef = useRef(createRobustFitBoundsAccumulator());
  const finalBoundsRefittedRef = useRef(false);
  const cameraSnapshotRef = useRef<{ px: number; py: number; pz: number; tx: number; ty: number; tz: number } | null>(null);
  // Tracks which fit branch the post-load auto-fit took. Linear models get a
  // one-time status-line hint via the viewer store; the home button can also
  // mirror the same policy on re-press without re-deriving the bbox shape.
  const lastFitPolicyKindRef = useRef<'compact' | 'linear' | null>(null);
  const prevIsStreamingRef = useRef(isStreaming);
  const pendingFinalizeRef = useRef<{
    renderer: NonNullable<typeof rendererRef.current>; geometry: typeof geometry; replacement: number; scene: ReturnType<NonNullable<typeof rendererRef.current>['getScene']>;
    trace: ReturnType<typeof activeLoadTrace>; running: boolean; attempts: number;
  } | null>(null);
  // A scheduled drain is not a completed finalization. Keep its same-load
  // ownership across recovery cleanup, but never finalize a replacement load.
  useEffect(() => {
    const pending = pendingFinalizeRef.current;
    if (!geometry || geometry.length === 0) {
      pendingFinalizeRef.current = null;
      prevIsStreamingRef.current = isStreaming;
      return;
    }
    if (pending && (isStreaming ||
      pending.replacement !== geometryReplacementVersion ||
      pending.renderer !== rendererRef.current || pending.scene !== rendererRef.current?.getScene())) {
      pendingFinalizeRef.current = null;
      prevIsStreamingRef.current = isStreaming;
    } else if (pending && !pending.running) {
      // Same-load array changes retain the drain; explicit replacement rebuilds the Scene.
      pending.geometry = geometry;
    }
  }, [geometry, geometryReplacementVersion, isStreaming, rendererRef.current, isInitialized, gpuRecoveryEpoch]);
  useEffect(() => () => { pendingFinalizeRef.current = null; }, []);
  const lastContentVersionRef = useRef(geometryContentVersion ?? 0);
  const prevModelCountRef = useRef(modelCount);
  const queuePumpTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

  // Only activate the timer-based queue pump when the tab is background-throttled
  // (rAF stops firing). In the foreground, the animation loop already drains the
  // queue every frame — a parallel setTimeout(0) pump doubles the GPU work and
  // hurts Chrome (Dawn) where each buffer op is an IPC round-trip.
  const ensureQueuePump = () => {
    if (queuePumpTimerRef.current !== null) return;
    if (!globalThis.document?.hidden) return; // rAF is active — let the animation loop drain
    queuePumpTimerRef.current = globalThis.setTimeout(() => {
      queuePumpTimerRef.current = null;
      const renderer = rendererRef.current;
      if (!renderer || !isInitialized) return;
      const device = renderer.getGPUDevice();
      const pipeline = renderer.getPipeline();
      const scene = renderer.getScene();
      if (!device || !pipeline || !scene.hasQueuedMeshes()) return;
      // Hidden tab: nobody can be navigating. If the tab turned visible before this
      // timer fired, keep the short slice as if the user were (#6436).
      const flushed = runGpuUpload('flushPending:pump', () => flushPlacementGeometry(scene, device, pipeline, !globalThis.document?.hidden)) ?? false;
      if (flushed) {
        renderer.clearCaches();
        renderer.requestRender();
      }
      if (scene.hasQueuedMeshes()) {
        ensureQueuePump();
      }
    }, 0);
  };

  // Declared BEFORE the main effect: it swaps edited meshes in the scene and
  // advances the refs below past them (see useMeshEditDrain.ts).
  useMeshEditDrain({
    rendererRef, isInitialized, gpuRecoveryEpoch, isStreaming, geometry, pendingMeshRemovals, clearPendingMeshRemovals,
    pruneGeometryMeshes, lastGeometryLengthRef, lastGeometryRef, processedMeshIdsRef,
    geometryReplacementVersion, lastReplacementVersionRef,
  });

  // ─── Main geometry effect ────────────────────────────────────────────
  // Runs on every geometry change (new file, incremental batch, visibility toggle).
  // During streaming this is hot-path — it must be FAST (no GPU work).
  useEffect(() => {
    const renderer = rendererRef.current;

    // Geometry cleared/null — reset so next load is fresh
    if (!geometry) {
      if (lastGeometryLengthRef.current > 0 || lastGeometryRef.current !== null) {
        traceGeometrySync(`geometry cleared lastLength=${lastGeometryLengthRef.current}`);
        lastGeometryLengthRef.current = 0;
        lastGeometryRef.current = null;
        processedMeshIdsRef.current.clear();
        cameraFittedRef.current = false;
        finalBoundsRefittedRef.current = false;
        cameraSnapshotRef.current = null;
        robustFitAccRef.current.reset();
        if (renderer && isInitialized) {
          renderer.getScene().clear();
          invalidateLandXmlGpuOwnershipAfterSceneClear();
          renderer.getCamera().reset();
          geometryBoundsRef.current = { ...DEFAULT_BOUNDS };
          renderer.requestRender();
        }
      }
      return;
    }

    if (!renderer || !isInitialized) return;

    const device = renderer.getGPUDevice();
    if (!device) return;

    const scene = renderer.getScene();
    const currentLength = geometry.length;

    // In-place mutation detection: when geometryContentVersion bumps, mesh
    // positions/normals were rewritten in place (e.g. realignFederation).
    // Length-based classification can't catch this, so force a full reset and
    // re-process the geometry from scratch so the GPU re-uploads buffers.
    const contentVersion = geometryContentVersion ?? 0;
    if (contentVersion !== lastContentVersionRef.current) {
      lastContentVersionRef.current = contentVersion;
      if (lastGeometryLengthRef.current > 0) {
        traceGeometrySync(`geometry content version bumped → ${contentVersion}; re-uploading buffers`);
        // Resetting lastGeometryLengthRef to 0 makes the classification below
        // read this as `isNewFile` — that branch owns the actual scene
        // reshape (and, #2073, the instanced-retention reconcile), so this
        // block only resets tracking state and must NOT touch the scene
        // itself (a second reshape here would be immediately redundant).
        processedMeshIdsRef.current.clear();
        lastGeometryLengthRef.current = 0;
        lastGeometryRef.current = null;
      }
    }

    // A model was added to the federation — refit the camera to the new
    // combined bounds. Without this, `cameraFittedRef` stays true from the
    // first model's fit, so the newly-added model renders off-screen and only
    // its 2D grid overlay shows. Refit only on an INCREASE (a model added),
    // and never mid-stream (the streaming first-fit + finalize refit handle
    // the active model). The combined bounds come from the merged
    // coordinateInfo (union of all visible models).
    if (modelCount > prevModelCountRef.current && !isStreaming) {
      traceGeometrySync(`model added (${prevModelCountRef.current}→${modelCount}) — refitting camera to combined bounds`);
      cameraFittedRef.current = false;
      finalBoundsRefittedRef.current = false;
      robustFitAccRef.current.reset();
    }
    prevModelCountRef.current = modelCount;

    // Read AFTER the optional reset above so the classification below reflects
    // the post-reset state (otherwise an in-place update gets misclassified as
    // "no change" and returns early at currentLength === lastLength).
    const lastLength = lastGeometryLengthRef.current;

    // ── Classify the change ──
    const isReplacement = geometryReplacementVersion !== lastReplacementVersionRef.current;
    lastReplacementVersionRef.current = geometryReplacementVersion;
    const isIncremental = !isReplacement && currentLength > lastLength && lastLength > 0;
    const isNewFile = currentLength > 0 && lastLength === 0;
    const isCleared = currentLength === 0;

    if (isCleared) {
      reshapeSceneKeepingPresentInstanced(scene, presentInstancedModelIndices, geometry, appearanceSourceGeometry);
      invalidateLandXmlGpuOwnershipAfterSceneClear();
      processedMeshIdsRef.current.clear();
      lastGeometryLengthRef.current = 0;
      lastGeometryRef.current = null;
      renderer.requestRender();
      return;
    }

    if (isNewFile) {
      traceGeometrySync(`new file currentLength=${currentLength} lastLength=${lastLength} releaseAfterFinalize=${releaseGeometryAfterFinalize}`);
      // Reconcile flat geometry while retaining present instanced templates.
      reshapeSceneKeepingPresentInstanced(scene, presentInstancedModelIndices, geometry, appearanceSourceGeometry);
      invalidateLandXmlGpuOwnershipAfterSceneClear();
      scene.setEphemeralStreamingMode(releaseGeometryAfterFinalize);
      processedMeshIdsRef.current.clear();
      cameraFittedRef.current = false;
      finalBoundsRefittedRef.current = false;
      cameraSnapshotRef.current = null;
      robustFitAccRef.current.reset();
      lastGeometryLengthRef.current = 0;
      lastGeometryRef.current = geometry;
      renderer.getCamera().reset();
      geometryBoundsRef.current = { ...DEFAULT_BOUNDS };
    } else if (isReplacement || currentLength < lastLength) {
      traceGeometrySync(`geometry rebuilt after replacement/shrink currentLength=${currentLength} lastLength=${lastLength}`);
      // An existing model changed, or visibility removed meshes. Keep the
      // camera and present instanced owners while replacing flat buffers.
      reshapeSceneKeepingPresentInstanced(scene, presentInstancedModelIndices, geometry, appearanceSourceGeometry);
      invalidateLandXmlGpuOwnershipAfterSceneClear();
      scene.setEphemeralStreamingMode(releaseGeometryAfterFinalize);
      processedMeshIdsRef.current.clear();
      robustFitAccRef.current.reset();
      lastGeometryLengthRef.current = 0;
      lastGeometryRef.current = geometry;
    } else if (currentLength === lastLength) {
      // No mesh-count change, so the queueMeshes / appendToBatches block
      // below would be a no-op. But we MUST still reach the camera-fit
      // block — the streaming-complete re-render (isStreaming flips
      // false, geometry array length stays at the final mesh count)
      // arrives here, and that's the FIRST render where path 2
      // (`computeBounds(geometry)` fallback when shiftedBounds is empty)
      // is allowed to fire. Pre-fix the early return short-circuited
      // the camera fit entirely; the user reported 33 meshes streamed
      // with the viewport stuck at the default ±100 m bounds (issue
      // #859 / PR #871 deploy preview, `linear-placement-of-signal.ifc`).
      //
      // Skip only when the camera is already fitted or there's nothing
      // to fit to.
      if (cameraFittedRef.current || currentLength === 0) {
        return;
      }
      // Otherwise fall through so the camera-fit block at the bottom of
      // the effect gets a chance to run. ONLY the camera fit: an unchanged
      // length carries no new mesh, and the streaming fast path never records
      // the keys the rebuild scan below consults, so that scan would upload
      // every streamed mesh a second time (a mesh-less scan joining a streamed
      // IFC, or the #859 streaming-complete fit; #6953).
    }
    const unchangedLength = !isReplacement && currentLength === lastLength;

    // Visibility toggle while NOT streaming — array rebuilt from scratch
    if (isIncremental && !isStreaming && !prevIsStreamingRef.current) {
      reshapeSceneKeepingPresentInstanced(scene, presentInstancedModelIndices, geometry, appearanceSourceGeometry);
      invalidateLandXmlGpuOwnershipAfterSceneClear();
      processedMeshIdsRef.current.clear();
      lastGeometryLengthRef.current = 0;
      lastGeometryRef.current = geometry;
    }

    if (isIncremental) {
      lastGeometryRef.current = geometry;
    } else if (lastGeometryRef.current === null) {
      lastGeometryRef.current = geometry;
    }

    // ── Extract new meshes ──
    let newMeshes: MeshData[];
    const claimedMeshKeys: string[] = [];
    let appendFailed = false;
    if (unchangedLength) {
      newMeshes = [];
    } else if (isStreaming || isIncremental) {
      // Fast path: new meshes are always appended at end
      const start = lastGeometryLengthRef.current;
      newMeshes = geometry.slice(start);
    } else {
      // Slow path: scan for unprocessed meshes (full rebuild)
      newMeshes = [];
      for (let i = 0; i < geometry.length; i++) {
        const meshData = geometry[i];
        const compoundKey = geometryMeshKey(meshData, i);
        if (!processedMeshIdsRef.current.has(compoundKey)) {
          newMeshes.push(meshData);
          // Marked processed BEFORE the upload runs, so the keys are kept to
          // roll back if it fails — otherwise a failed batch would be recorded
          // as done and never retried (silently missing geometry).
          processedMeshIdsRef.current.add(compoundKey);
          claimedMeshKeys.push(compoundKey);
        }
      }
    }

    // ── Route meshes to scene ──
    // A LandXML provisional transaction may have uploaded these exact
    // store-owned meshes after its registry range became pickable. Consume the
    // one-shot marker so normal scene rebuilds still own later re-uploads.
    newMeshes = newMeshes.filter((mesh) => !takeLandXmlGpuUploaded(mesh));
    if (newMeshes.length > 0) {
      // #6979: per-batch spans on the streaming load (no-op when not streaming or untraced).
      const trace = isStreaming ? activeLoadTrace() : NOOP_LOAD_TRACE;
      const arrived = newMeshes;
      newMeshes = trace.span('stream.place', () => placeNewMeshesAtCurrentLevel(arrived, currentLevelY ?? new Map()));
      const pipeline = renderer.getPipeline();
      if (pipeline) {
        if (isStreaming) {
          // Queue for the animation loop — zero GPU work here.
          const queued = newMeshes;
          trace.span('stream.queue', () => scene.queueMeshes(queued));
          // Desktop benchmark windows can become background-throttled, which
          // stalls requestAnimationFrame-based draining. Keep a timer-based
          // pump active so large native loads still finish offscreen.
          ensureQueuePump();
        } else {
          // Non-streaming: process immediately (visibility toggles, etc.)
          // The production crash path: this effect is where a failed
          // createBuffer escaped into React's commit phase and unmounted the
          // viewport, blanking the canvas.
          const uploaded = runGpuUpload('appendToBatches:non-streaming', () => {
            scene.appendToBatches(newMeshes, device, pipeline, false);
            return true;
          }) ?? false;
          if (uploaded) {
            renderer.clearCaches();
          } else {
            appendFailed = true;
            // Release the claim so a later pass retries these meshes rather
            // than leaving a permanent hole in the model.
            for (const key of claimedMeshKeys) {
              processedMeshIdsRef.current.delete(key);
            }
          }
        }
      }
    }

    // The incremental/fast path tracks progress by length rather than by
    // key, so it needs the same rollback: leaving this un-advanced is what
    // makes the failed append retryable there.
    if (!appendFailed) {
      lastGeometryLengthRef.current = currentLength;
    }

    // ── Fit camera ──
    //
    // Pre-#871 the branching here was structured as
    //   if (coordinateInfo?.shiftedBounds) { try to fit }
    //   else if (geometry.length > 0) { fall back }
    // but `coordinateInfo.shiftedBounds` is ALWAYS truthy — the wasm
    // bridge ships a default `{ min: 0, max: 0 }` placeholder before
    // any real bounds get computed. The outer `if` therefore won
    // every time, the inner `maxSize > 0` failed, and the `else if`
    // fallback NEVER fired. Result: the camera stayed at the default
    // (0, 0, 0) framing while linearly-placed railway geometry sat at
    // its MGA-territory world coords (~330, 123 after RTC), invisible
    // to the user. Compute the size first so the branch reflects
    // whether the data is actually usable, not just whether the
    // property exists.
    if (!cameraFittedRef.current) {
      const fitStart = performance.now();
      // The adaptive fit picks an SE-isometric pose for compact models
      // (today's behaviour) but switches to a side-on-along-the-alignment
      // pose for high-aspect-ratio bboxes (railway / road corridors).
      // Without the switch, a 932 × 0.75 × 428 m alignment auto-fits to a
      // ~1864 m distance where every 1 m signal projects to a sub-pixel
      // dot — the user sees a blank viewport even though geometry is in
      // the scene. See packages/renderer/src/camera-fit-policy.ts.
      let fitted = false;
      // Outlier-robust framing takes precedence over the raw wasm AABB when a
      // sparse far tail would otherwise park the fit target / orbit pivot in
      // empty space (issue #1394). `robust` is null for models without such a
      // tail, leaving the shiftedBounds / computeBounds paths below untouched.
      // `sceneBoundsFull` is the FULL AABB and is what feeds setSceneBounds —
      // near/far clipping + section ranges must still cover the far meshes.
      const rbEarly = geometry.length > 0 ? robustFitAccRef.current.update(geometry, { streaming: isStreaming }) : null;
      const robustEarly = rbEarly?.robust ?? null;
      let sceneBoundsFull: Bounds | null = null;
      if (robustEarly) {
        const canvas = renderer.getCanvas();
        const canvasShort = Math.min(canvas?.clientHeight ?? 0, canvas?.clientWidth ?? 0); // CSS px (#5383)
        const policy = renderer.getCamera().fitBoundsAdaptive(
          robustEarly,
          { viewportShortPx: canvasShort > 0 ? canvasShort : undefined },
        );
        geometryBoundsRef.current = robustEarly;
        sceneBoundsFull = rbEarly!.full;
        lastFitPolicyKindRef.current = policy.kind;
        fitted = true;
      }
      const sb = coordinateInfo?.shiftedBounds;
      if (!fitted && sb) {
        const maxSize = Math.max(sb.max.x - sb.min.x, sb.max.y - sb.min.y, sb.max.z - sb.min.z);
        if (maxSize > 0 && Number.isFinite(maxSize)) {
          const canvas = renderer.getCanvas();
          const canvasShort = Math.min(canvas?.clientHeight ?? 0, canvas?.clientWidth ?? 0); // CSS px (#5383)
          const policy = renderer.getCamera().fitBoundsAdaptive(
            { min: sb.min, max: sb.max },
            { viewportShortPx: canvasShort > 0 ? canvasShort : undefined },
          );
          geometryBoundsRef.current = { min: { ...sb.min }, max: { ...sb.max } };
          // shiftedBounds is the full wasm AABB.
          sceneBoundsFull = { min: { ...sb.min }, max: { ...sb.max } };
          lastFitPolicyKindRef.current = policy.kind;
          fitted = true;
        }
      }
      if (!fitted && geometry.length > 0 && !isStreaming) {
        const bounds = computeBounds(geometry);
        if (bounds) {
          const canvas = renderer.getCanvas();
          const canvasShort = Math.min(canvas?.clientHeight ?? 0, canvas?.clientWidth ?? 0); // CSS px (#5383)
          const policy = renderer.getCamera().fitBoundsAdaptive(
            bounds,
            { viewportShortPx: canvasShort > 0 ? canvasShort : undefined },
          );
          geometryBoundsRef.current = bounds;
          sceneBoundsFull = bounds;
          lastFitPolicyKindRef.current = policy.kind;
          fitted = true;
        }
      }
      if (fitted) {
        cameraFittedRef.current = true;
        tracePhaseOnce(activeLoadTrace(), 'camera.fit').record('camera.fit', fitStart, performance.now(), { policy: lastFitPolicyKindRef.current ?? 'none', robust: robustEarly !== null });
        // Populate the camera's cached scene bounds. The viewer streams meshes
        // directly (not via Renderer.loadGeometry), so this is the only place
        // the camera learns the bounds — consumers like the orbit-pivot
        // fallback (issue #1107) and tight near/far clipping depend on it.
        // Use the FULL AABB so clipping/section ranges still cover far meshes;
        // the trimmed robust box only drives framing + the orbit anchor (#1394).
        renderer.getCamera().setSceneBounds(sceneBoundsFull ?? geometryBoundsRef.current);
        // Pin (or clear) the robust orbit-pivot anchor for this model (#1394).
        renderer.getCamera().setOrbitAnchorBounds(robustEarly);
        const pos = renderer.getCamera().getPosition();
        const tgt = renderer.getCamera().getTarget();
        cameraSnapshotRef.current = { px: pos.x, py: pos.y, pz: pos.z, tx: tgt.x, ty: tgt.y, tz: tgt.z };
        // One-time hint for linear-infrastructure models. The side-on auto-fit
        // shows a slice of the alignment at a useful zoom — but the FULL
        // alignment is much longer than what fits on screen, so users need
        // to know to pan / use Frame Selection to inspect remote stations.
        // Hint is module-scoped so model swaps within one session don't spam.
        if (lastFitPolicyKindRef.current === 'linear' && !linearFitHintShown) {
          linearFitHintShown = true;
          toast.info('Linear infrastructure — pan along the alignment, or select an element and press F to zoom in');
        }
      }
    }

    renderer.requestRender();
  }, [geometry, geometryVersion, geometryReplacementVersion, geometryContentVersion, appearanceSourceGeometry, coordinateInfo, isInitialized, gpuRecoveryEpoch, isStreaming, modelCount]);

  useEffect(() => {
    return () => {
      if (queuePumpTimerRef.current !== null) {
        globalThis.clearTimeout(queuePumpTimerRef.current);
        queuePumpTimerRef.current = null;
      }
    };
  }, []);

  // ─── Streaming complete: finalize + bounds refit ─────────────────────
  useEffect(() => {
    const renderer = rendererRef.current;
    // A slow renderer init can outlast the stream: remember it was seen so its end still finalizes (#7032).
    if (!renderer || !isInitialized || !renderer.getGPUDevice()) { if (isStreaming) prevIsStreamingRef.current = true; return; }
    if (!isStreaming && (prevIsStreamingRef.current || pendingFinalizeRef.current)) {
      const pending = pendingFinalizeRef.current ?? { renderer, geometry, replacement: geometryReplacementVersion,
        scene: renderer.getScene(), trace: activeLoadTrace(), running: false, attempts: 0 };
      pendingFinalizeRef.current = pending;
      if (pending.running) return;
      const scene = renderer.getScene();
      traceGeometrySync(
        `stream transition complete geometryLength=${geometry?.length ?? 0} queued=${scene.hasQueuedMeshes()} batches=${scene.getBatchedMeshes().length}`
      );
      renderer.requestRender();

      const capturedGeometry = pending.geometry;
      const trace = pending.trace; // #6979: bind the original load owner.
      const drainStart = performance.now();
      let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
      let rafId: number | null = null;

      const startFinalize = () => {
        timeoutId = globalThis.setTimeout(() => {
          const r = rendererRef.current;
          if (!r || pending.renderer !== r || pendingFinalizeRef.current !== pending || r.getScene() !== pending.scene) return;

          tracePhaseOnce(trace, 'stream.queueDrain').record('stream.queueDrain', drainStart, performance.now());
          console.log('[GeomStream] Streaming ended — starting finalize');
          traceGeometrySync(
            `finalize start geometryLength=${capturedGeometry?.length ?? 0} releaseAfterFinalize=${releaseGeometryAfterFinalize}`
          );

          refitCompletedStreamBounds({ renderer: r, capturedGeometry, cameraFittedRef,
            finalBoundsRefittedRef, robustFitAccRef, cameraSnapshotRef,
            lastFitPolicyKindRef, geometryBoundsRef, trace,
            notifyLinearFit: () => {
              if (linearFitHintShown) return;
              linearFitHintShown = true;
              toast.info('Linear infrastructure — pan along the alignment, or select an element and press F to zoom in');
            } });

          // Time-sliced finalize: rebuild proper batches in ~8ms chunks
          if (releaseGeometryAfterFinalize) {
            const finished = runGpuUpload('finishEphemeralStreaming:stream-end', () => {
              tracePhaseOnce(trace, 'scene.finalize').span('scene.finalize', () => r.getScene().finishEphemeralStreaming(), { ephemeral: true });
              return true;
            });
            if (!finished) return;
            if (pendingFinalizeRef.current === pending) pendingFinalizeRef.current = null;
            onGeometryReleased?.();
            r.clearCaches();
            r.requestRender();
            traceGeometrySync(`ephemeral finalize complete batches=${r.getScene().getBatchedMeshes().length}`);
            return;
          }

          const dev = r.getGPUDevice();
          const pipe = r.getPipeline();
          if (dev && pipe) {
            const t0 = performance.now();
            pending.running = true;
            // Preserve failure; later attempts record their own outcome.
            const attemptTrace = pending.attempts++ === 0 ? tracePhaseOnce(trace, 'scene.finalize') : trace;
            const completion = runGpuUpload('finalizeStreamingAsync:stream-end', () =>
              r.getScene().finalizeStreamingAsync(dev, pipe, undefined, attemptTrace));
            if (!completion) { pending.running = false; return; }
            void completion.then(() => {
              if (pendingFinalizeRef.current !== pending || rendererRef.current !== r || r.getScene() !== pending.scene) return;
              pendingFinalizeRef.current = null;
              const batchCount = r.getScene().getBatchedMeshes().length;
              let totalIdx = 0;
              for (const b of r.getScene().getBatchedMeshes()) totalIdx += b.indexCount;
              console.log(`[GeomStream] finalizeStreamingAsync complete: ${(performance.now() - t0).toFixed(0)}ms → ${batchCount} consolidated batches, ${(totalIdx / 3 / 1e6).toFixed(1)}M triangles`);
              traceGeometrySync(
                `finalize complete elapsed=${(performance.now() - t0).toFixed(0)}ms batches=${batchCount} queued=${r.getScene().hasQueuedMeshes()}`
              );
              r.clearCaches();
              r.requestRender();
            }, (error: unknown) => {
              pending.running = false;
              if (pendingFinalizeRef.current === pending && rendererRef.current === r && r.getScene() === pending.scene) wakeAfterFailure(gpuRecoveryEpoch);
              console.warn('[GeomStream] Finalization failed; retaining same-load retry:', error);
            });
          }
        }, 0);
      };

      const waitForQueueDrain = () => {
        const currentRenderer = rendererRef.current;
        if (!currentRenderer || pending.renderer !== currentRenderer || pendingFinalizeRef.current !== pending || currentRenderer.getScene() !== pending.scene) return;
        if (!currentRenderer.getScene().hasQueuedMeshes()) {
          startFinalize();
          return;
        }
        currentRenderer.requestRender();
        rafId = requestAnimationFrame(waitForQueueDrain);
      };

      waitForQueueDrain();

      prevIsStreamingRef.current = isStreaming;
      return () => {
        if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }
    prevIsStreamingRef.current = isStreaming;
  }, [isStreaming, isInitialized, gpuRecoveryEpoch, finalizeWake, geometry, geometryReplacementVersion, releaseGeometryAfterFinalize, onGeometryReleased, wakeAfterFailure]);

  // ─── Mesh color updates (style/material deferred colors) ─────────────
  useEffect(() => {
    if (pendingMeshColorUpdates === null || !isInitialized) return;
    const renderer = rendererRef.current;
    if (!renderer) return;

    const device = renderer.getGPUDevice();
    const pipeline = renderer.getPipeline();
    const scene = renderer.getScene();
    if (device && pipeline && pendingMeshColorUpdates.size > 0) {
      scene.updateMeshColors(pendingMeshColorUpdates, device, pipeline);
      renderer.requestRender();
      clearPendingMeshColorUpdates();
    }
  }, [pendingMeshColorUpdates, isInitialized, gpuRecoveryEpoch, clearPendingMeshColorUpdates]);

  // ─── GPU-instancing shards ───────────────────────────────────────────
  // The geometry worker collates each batch into an IFNS shard; the loader
  // pushes the raw bytes into pendingInstancedShards, tagged with the owning
  // model's id. Drain here: decode, re-home each occurrence's id onto that
  // model's express-id space, and upload under that model's modelIndex
  // (#1912 — a federated model's shards used to be dropped before ever
  // reaching this drain, since the loader only forwarded the primary's).
  useEffect(() => {
    if (pendingInstancedShards === null || !isInitialized) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const device = renderer.getGPUDevice();
    const scene = renderer.getScene();
    if (!device) return;

    if (pendingInstancedShards.length > 0) {
      const trace = activeLoadTrace(); // #6979: shards only arrive while a load streams
      for (const { modelId, bytes } of pendingInstancedShards) {
        // CRITICAL: never let a shard decode/upload throw OUT of this effect.
        // addInstancedShard creates GPU buffers; on a degraded
        // backend whose device is being lost (e.g. CI's SwiftShader), createBuffer
        // throws — and an uncaught throw in a React effect tears down the Viewport
        // subtree via the error boundary, unmounting the <canvas> entirely. Instanced
        // overlays are non-essential, so swallow per-shard failures: the flat geometry
        // still renders.
        try {
          const shard = trace.span('instanced.decode', () => decodeInstancedShard(new Uint8Array(bytes)));
          if (!shard) continue;
          applyFederationOffsetToShard(shard, modelIdToOffset?.get(modelId) ?? 0);
          liftNewInstancedOccurrences(shard, currentLevelY ?? new Map());
          const modelIndex = modelIdToIndex?.get(modelId) ?? 0;
          trace.span('instanced.upload', () => scene.addInstancedShard(device, shard, modelIndex));
        } catch (err) {
          console.warn('[useGeometryStreaming] instanced shard upload failed (device lost?), skipping:', err);
        }
      }
      renderer.requestRender();
    }
    clearInstancedShards();
  }, [pendingInstancedShards, modelIdToIndex, modelIdToOffset, isInitialized, gpuRecoveryEpoch, clearInstancedShards]);

  usePlacementMutationDrain({ rendererRef, isInitialized, gpuRecoveryEpoch,
    kind: 'translations', pending: pendingMeshTranslations, clearPending: clearPendingMeshTranslations });
  usePlacementMutationDrain({ rendererRef, isInitialized, gpuRecoveryEpoch,
    kind: 'rotations', pending: pendingMeshRotations, clearPending: clearPendingMeshRotations });

  // ─── Lens color overlays ─────────────────────────────────────────────
  useColorOverlaySync({
    rendererRef,
    isInitialized, gpuRecoveryEpoch,
    pendingColorUpdates,
    clearPendingColorUpdates,
    geometryVersion,
  });
}

export default useGeometryStreaming;
