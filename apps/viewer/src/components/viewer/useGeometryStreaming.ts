/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import { logToDesktopTerminal } from '@/services/desktop-logger';

export interface UseGeometryStreamingParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  geometry: MeshData[] | null;
  /** Monotonic counter — triggers the streaming effect even when the geometry
   *  array reference is stable (incremental filtering reuses the same array). */
  geometryVersion?: number;
  /**
   * Monotonic counter that bumps whenever existing mesh data has been mutated
   * in place (e.g. realignFederation rewrote vertex positions). Length-based
   * triggers can't detect in-place mutation, so when this bumps we treat the
   * incoming `geometry` as a fresh replacement and re-upload it to the GPU.
   */
  geometryContentVersion?: number;
  coordinateInfo?: CoordinateInfo;
  isStreaming: boolean;
  geometryBoundsRef: MutableRefObject<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }>;
  pendingMeshColorUpdates: Map<number, [number, number, number, number]> | null;
  pendingColorUpdates: Map<number, [number, number, number, number]> | null;
  /**
   * Authoring actions (split, delete) push globalIds here; the
   * streaming loop drains them via `scene.removeMeshesForEntities`
   * so tombstoned IFC entities disappear from the rendered scene
   * (rather than just being hidden via `hiddenIds`). Cleared by
   * the hook after the drain.
   */
  pendingMeshRemovals: Set<number> | null;
  /**
   * Per-entity translations queued by authoring actions (gizmo
   * drag, numeric move). Drained by the streaming hook into
   * `scene.translateMeshesForEntities` so the visible mesh
   * follows the IFC coordinate mutation on the next frame.
   */
  pendingMeshTranslations: Map<number, [number, number, number]> | null;
  clearPendingMeshColorUpdates: () => void;
  clearPendingColorUpdates: () => void;
  clearPendingMeshRemovals: () => void;
  clearPendingMeshTranslations: () => void;
  clearColorRef: MutableRefObject<[number, number, number, number]>;
  releaseGeometryAfterFinalize?: boolean;
  onGeometryReleased?: () => void;
}

// Default bounds used when geometry is cleared
const DEFAULT_BOUNDS = {
  min: { x: -100, y: -100, z: -100 },
  max: { x: 100, y: 100, z: 100 },
};

const MAX_VALID_COORD = 10000;

function traceGeometrySync(message: string): void {
  console.log(`[GeomSync] ${message}`);
  void logToDesktopTerminal('info', `[GeomSync] ${message}`);
}

export function useGeometryStreaming(params: UseGeometryStreamingParams): void {
  const {
    rendererRef,
    isInitialized,
    geometry,
    geometryVersion,
    geometryContentVersion,
    coordinateInfo,
    isStreaming,
    geometryBoundsRef,
    pendingMeshColorUpdates,
    pendingColorUpdates,
    pendingMeshRemovals,
    pendingMeshTranslations,
    clearPendingMeshColorUpdates,
    clearPendingColorUpdates,
    clearPendingMeshRemovals,
    clearPendingMeshTranslations,
    clearColorRef,
    releaseGeometryAfterFinalize = false,
    onGeometryReleased,
  } = params;

  // ─── Tracking refs ───────────────────────────────────────────────────
  const processedMeshIdsRef = useRef<Set<string>>(new Set());
  const lastGeometryLengthRef = useRef(0);
  const lastGeometryRef = useRef<MeshData[] | null>(null);
  const cameraFittedRef = useRef(false);
  const finalBoundsRefittedRef = useRef(false);
  const cameraSnapshotRef = useRef<{ px: number; py: number; pz: number; tx: number; ty: number; tz: number } | null>(null);
  const prevIsStreamingRef = useRef(isStreaming);
  const lastContentVersionRef = useRef(geometryContentVersion ?? 0);
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
      const flushed = scene.flushPending(device, pipeline);
      if (flushed) {
        renderer.clearCaches();
        renderer.requestRender();
      }
      if (scene.hasQueuedMeshes()) {
        ensureQueuePump();
      }
    }, 0);
  };

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
        if (renderer && isInitialized) {
          renderer.getScene().clear();
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
        scene.clear();
        processedMeshIdsRef.current.clear();
        lastGeometryLengthRef.current = 0;
        lastGeometryRef.current = null;
      }
    }

    // Read AFTER the optional reset above so the classification below reflects
    // the post-reset state (otherwise an in-place update gets misclassified as
    // "no change" and returns early at currentLength === lastLength).
    const lastLength = lastGeometryLengthRef.current;

    // ── Classify the change ──
    const isIncremental = currentLength > lastLength && lastLength > 0;
    const isNewFile = currentLength > 0 && lastLength === 0;
    const isCleared = currentLength === 0;

    if (isCleared) {
      scene.clear();
      processedMeshIdsRef.current.clear();
      lastGeometryLengthRef.current = 0;
      lastGeometryRef.current = null;
      renderer.requestRender();
      return;
    }

    if (isNewFile) {
      traceGeometrySync(`new file currentLength=${currentLength} lastLength=${lastLength} releaseAfterFinalize=${releaseGeometryAfterFinalize}`);
      scene.clear();
      scene.setEphemeralStreamingMode(releaseGeometryAfterFinalize);
      processedMeshIdsRef.current.clear();
      cameraFittedRef.current = false;
      finalBoundsRefittedRef.current = false;
      cameraSnapshotRef.current = null;
      lastGeometryLengthRef.current = 0;
      lastGeometryRef.current = geometry;
      renderer.getCamera().reset();
      geometryBoundsRef.current = { ...DEFAULT_BOUNDS };
    } else if (!isIncremental && currentLength !== lastLength) {
      if (currentLength < lastLength) {
        traceGeometrySync(`geometry rebuilt after shrink currentLength=${currentLength} lastLength=${lastLength}`);
        // Length decreased (model hidden) — rebuild scene, keep camera
        scene.clear();
        scene.setEphemeralStreamingMode(releaseGeometryAfterFinalize);
        processedMeshIdsRef.current.clear();
        lastGeometryLengthRef.current = 0;
        lastGeometryRef.current = geometry;
      } else {
        traceGeometrySync(`geometry rebuilt after replace currentLength=${currentLength} lastLength=${lastLength} releaseAfterFinalize=${releaseGeometryAfterFinalize}`);
        // New file while another was open — full reset
        scene.clear();
        scene.setEphemeralStreamingMode(releaseGeometryAfterFinalize);
        processedMeshIdsRef.current.clear();
        cameraFittedRef.current = false;
        finalBoundsRefittedRef.current = false;
        cameraSnapshotRef.current = null;
        lastGeometryLengthRef.current = 0;
        lastGeometryRef.current = geometry;
        renderer.getCamera().reset();
        geometryBoundsRef.current = { ...DEFAULT_BOUNDS };
      }
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
      // the effect gets a chance to run.
    }

    // Visibility toggle while NOT streaming — array rebuilt from scratch
    if (isIncremental && !isStreaming && !prevIsStreamingRef.current) {
      scene.clear();
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
    if (isStreaming || isIncremental) {
      // Fast path: new meshes are always appended at end
      const start = lastGeometryLengthRef.current;
      newMeshes = geometry.slice(start);
    } else {
      // Slow path: scan for unprocessed meshes (full rebuild)
      newMeshes = [];
      for (let i = 0; i < geometry.length; i++) {
        const meshData = geometry[i];
        const compoundKey = `${meshData.expressId}:${i}`;
        if (!processedMeshIdsRef.current.has(compoundKey)) {
          newMeshes.push(meshData);
          processedMeshIdsRef.current.add(compoundKey);
        }
      }
    }

    // ── Route meshes to scene ──
    if (newMeshes.length > 0) {
      const pipeline = renderer.getPipeline();
      if (pipeline) {
        if (isStreaming) {
          // Queue for the animation loop — zero GPU work here.
          scene.queueMeshes(newMeshes);
          // Desktop benchmark windows can become background-throttled, which
          // stalls requestAnimationFrame-based draining. Keep a timer-based
          // pump active so large native loads still finish offscreen.
          ensureQueuePump();
        } else {
          // Non-streaming: process immediately (visibility toggles, etc.)
          scene.appendToBatches(newMeshes, device, pipeline, false);
          renderer.clearCaches();
        }
      }
    }

    lastGeometryLengthRef.current = currentLength;

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
      let fitted = false;
      const sb = coordinateInfo?.shiftedBounds;
      if (sb) {
        const maxSize = Math.max(sb.max.x - sb.min.x, sb.max.y - sb.min.y, sb.max.z - sb.min.z);
        if (maxSize > 0 && Number.isFinite(maxSize)) {
          renderer.getCamera().fitToBounds(sb.min, sb.max);
          geometryBoundsRef.current = { min: { ...sb.min }, max: { ...sb.max } };
          fitted = true;
        }
      }
      if (!fitted && geometry.length > 0 && !isStreaming) {
        const bounds = computeBounds(geometry);
        if (bounds) {
          renderer.getCamera().fitToBounds(bounds.min, bounds.max);
          geometryBoundsRef.current = bounds;
          fitted = true;
        }
      }
      if (fitted) {
        cameraFittedRef.current = true;
        const pos = renderer.getCamera().getPosition();
        const tgt = renderer.getCamera().getTarget();
        cameraSnapshotRef.current = { px: pos.x, py: pos.y, pz: pos.z, tx: tgt.x, ty: tgt.y, tz: tgt.z };
      }
    }

    renderer.requestRender();
  }, [geometry, geometryVersion, geometryContentVersion, coordinateInfo, isInitialized, isStreaming]);

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
    if (!renderer || !isInitialized) return;

    if (prevIsStreamingRef.current && !isStreaming) {
      const scene = renderer.getScene();
      traceGeometrySync(
        `stream transition complete geometryLength=${geometry?.length ?? 0} queued=${scene.hasQueuedMeshes()} batches=${scene.getBatchedMeshes().length}`
      );
      renderer.requestRender();

      const capturedGeometry = geometry;
      let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
      let rafId: number | null = null;

      const startFinalize = () => {
        timeoutId = globalThis.setTimeout(() => {
          const r = rendererRef.current;
          if (!r) return;

          console.log('[GeomStream] Streaming ended — starting finalize');
          traceGeometrySync(
            `finalize start geometryLength=${capturedGeometry?.length ?? 0} releaseAfterFinalize=${releaseGeometryAfterFinalize}`
          );

          // Compute exact bounds and refit camera (fast ~15ms scan)
          if (cameraFittedRef.current && !finalBoundsRefittedRef.current && capturedGeometry && capturedGeometry.length > 0) {
            const t0 = performance.now();
            const exactBounds = computeBounds(capturedGeometry);
            console.log(`[GeomStream] computeBounds: ${(performance.now() - t0).toFixed(0)}ms`);
            if (exactBounds) {
              if (!userMovedCamera(r, cameraSnapshotRef.current)) {
                r.getCamera().fitToBounds(exactBounds.min, exactBounds.max);
              }
              geometryBoundsRef.current = exactBounds;
              finalBoundsRefittedRef.current = true;
            }
          }

          // Time-sliced finalize: rebuild proper batches in ~8ms chunks
          if (releaseGeometryAfterFinalize) {
            r.getScene().finishEphemeralStreaming();
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
            r.getScene().finalizeStreamingAsync(dev, pipe).then(() => {
              const batchCount = r.getScene().getBatchedMeshes().length;
              let totalIdx = 0;
              for (const b of r.getScene().getBatchedMeshes()) totalIdx += b.indexCount;
              console.log(`[GeomStream] finalizeStreamingAsync complete: ${(performance.now() - t0).toFixed(0)}ms → ${batchCount} consolidated batches, ${(totalIdx / 3 / 1e6).toFixed(1)}M triangles`);
              traceGeometrySync(
                `finalize complete elapsed=${(performance.now() - t0).toFixed(0)}ms batches=${batchCount} queued=${r.getScene().hasQueuedMeshes()}`
              );
              r.clearCaches();
              r.requestRender();
            });
          }
        }, 0);
      };

      const waitForQueueDrain = () => {
        const currentRenderer = rendererRef.current;
        if (!currentRenderer) return;
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
  }, [isStreaming, isInitialized, releaseGeometryAfterFinalize, onGeometryReleased]);

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
  }, [pendingMeshColorUpdates, isInitialized, clearPendingMeshColorUpdates]);

  // ─── Mesh removals (split / delete) ───────────────────────────────────
  // Authoring actions push globalIds into pendingMeshRemovals; drain
  // here so the renderer actually drops them rather than leaving the
  // mesh hidden via the visibility set. The bucket rebuild rides
  // along on the existing rebuildPendingBatches path the streaming
  // queue already exercises every frame.
  useEffect(() => {
    if (pendingMeshRemovals === null || !isInitialized) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const device = renderer.getGPUDevice();
    const pipeline = renderer.getPipeline();
    const scene = renderer.getScene();
    if (!device || !pipeline) return;

    if (pendingMeshRemovals.size > 0) {
      scene.removeMeshesForEntities(pendingMeshRemovals);
      if (scene.hasPendingBatches()) {
        scene.rebuildPendingBatches(device, pipeline);
      }
      renderer.requestRender();
    }
    clearPendingMeshRemovals();
  }, [pendingMeshRemovals, isInitialized, clearPendingMeshRemovals]);

  // ─── Mesh translations (move / gizmo drag / numeric move) ────────────
  // Drain the pending-translation map onto the renderer. Same
  // rebuildPendingBatches ride-along; the in-place vertex update
  // means a translate frame is one batch rebuild per affected
  // bucket (typically one per entity).
  useEffect(() => {
    if (pendingMeshTranslations === null || !isInitialized) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const device = renderer.getGPUDevice();
    const pipeline = renderer.getPipeline();
    const scene = renderer.getScene();
    if (!device || !pipeline) return;

    if (pendingMeshTranslations.size > 0) {
      scene.translateMeshesForEntities(pendingMeshTranslations);
      if (scene.hasPendingBatches()) {
        scene.rebuildPendingBatches(device, pipeline);
      }
      renderer.requestRender();
    }
    clearPendingMeshTranslations();
  }, [pendingMeshTranslations, isInitialized, clearPendingMeshTranslations]);

  // ─── Lens color overlays ─────────────────────────────────────────────
  useEffect(() => {
    if (pendingColorUpdates === null || !isInitialized) return;
    const renderer = rendererRef.current;
    if (!renderer) return;

    const device = renderer.getGPUDevice();
    const pipeline = renderer.getPipeline();
    const scene = renderer.getScene();
    if (device && pipeline) {
      if (pendingColorUpdates.size === 0) {
        scene.clearColorOverrides();
      } else {
        scene.setColorOverrides(pendingColorUpdates, device, pipeline);
      }
      renderer.requestRender();
      clearPendingColorUpdates();
    }
  }, [pendingColorUpdates, isInitialized, clearPendingColorUpdates]);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function computeBounds(meshes: MeshData[]): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let gi = 0; gi < meshes.length; gi++) {
    const positions = meshes[gi].positions;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (Math.abs(x) < MAX_VALID_COORD && Math.abs(y) < MAX_VALID_COORD && Math.abs(z) < MAX_VALID_COORD) {
        if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
      }
    }
  }
  const maxSize = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (minX === Infinity || maxSize <= 0 || !Number.isFinite(maxSize)) return null;
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

function userMovedCamera(
  renderer: Renderer,
  snapshot: { px: number; py: number; pz: number; tx: number; ty: number; tz: number } | null,
): boolean {
  if (!snapshot) return false;
  const pos = renderer.getCamera().getPosition();
  const tgt = renderer.getCamera().getTarget();
  const EPS = 0.5;
  return (
    Math.abs(pos.x - snapshot.px) > EPS || Math.abs(pos.y - snapshot.py) > EPS || Math.abs(pos.z - snapshot.pz) > EPS ||
    Math.abs(tgt.x - snapshot.tx) > EPS || Math.abs(tgt.y - snapshot.ty) > EPS || Math.abs(tgt.z - snapshot.tz) > EPS
  );
}

export default useGeometryStreaming;
