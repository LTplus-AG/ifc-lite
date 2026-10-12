/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutableRefObject } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import type { LoadTrace } from '@ifc-lite/load-trace';
import { tracePhaseOnce } from '@/lib/perf/activeLoadTrace';
import { computeBounds, userMovedCamera, type Bounds } from './streamingBounds.js';
import type { createRobustFitBoundsAccumulator } from './robustFitBoundsAccumulator.js';

interface Params {
  renderer: Renderer;
  capturedGeometry: MeshData[] | null;
  cameraFittedRef: MutableRefObject<boolean>;
  finalBoundsRefittedRef: MutableRefObject<boolean>;
  robustFitAccRef: MutableRefObject<ReturnType<typeof createRobustFitBoundsAccumulator>>;
  cameraSnapshotRef: MutableRefObject<Parameters<typeof userMovedCamera>[1]>;
  lastFitPolicyKindRef: MutableRefObject<'compact' | 'linear' | null>;
  geometryBoundsRef: MutableRefObject<Bounds>;
  trace: LoadTrace;
  notifyLinearFit: () => void;
}

/** Existing post-stream camera refit, kept separate from drain ownership. */
export function refitCompletedStreamBounds(params: Params): void {
  const { renderer, capturedGeometry, cameraFittedRef, finalBoundsRefittedRef,
    robustFitAccRef, cameraSnapshotRef, lastFitPolicyKindRef, geometryBoundsRef,
    trace, notifyLinearFit } = params;
  // Compute exact bounds and refit camera (fast ~15ms scan). Use
  // the adaptive policy so linear-infrastructure models keep the
  // side-on pose chosen by the early-fit branch — without this,
  // the streaming-complete refit reverts to the legacy
  // `fitToBounds` (SE isometric at `maxSize * 2`), undoing the
  // useful close-in framing and putting the camera back at the
  // sub-pixel distance for railway / road corridors.
  if (cameraFittedRef.current && !finalBoundsRefittedRef.current && capturedGeometry && capturedGeometry.length > 0) {
    const t0 = performance.now();
    // Prefer outlier-robust framing so a sparse far tail can't park the
    // fit target (and the orbit pivot) in empty space (issue #1394).
    // `robust` is the trimmed framing box (null when there is no tail);
    // `fullBounds` is the complete AABB for clipping / section ranges.
    const rb = robustFitAccRef.current.update(capturedGeometry);
    const robust = rb?.robust ?? null;
    const fullBounds = rb?.full ?? computeBounds(capturedGeometry);
    const exactBounds = robust ?? fullBounds;
    // Pin (or clear) the robust orbit-pivot anchor. setSceneBounds gets
    // overwritten by the renderer's per-upload full-AABB sync, so the
    // pivot reads this dedicated anchor instead (issue #1394).
    renderer.getCamera().setOrbitAnchorBounds(robust);
    console.log(`[GeomStream] computeBounds: ${(performance.now() - t0).toFixed(0)}ms`);
    if (exactBounds) {
      if (!userMovedCamera(renderer, cameraSnapshotRef.current)) {
        const canvas = renderer.getCanvas();
        const canvasShort = Math.min(canvas?.clientHeight ?? 0, canvas?.clientWidth ?? 0); // CSS px (#5383)
        const policy = renderer.getCamera().fitBoundsAdaptive(
          exactBounds,
          { viewportShortPx: canvasShort > 0 ? canvasShort : undefined },
        );
        lastFitPolicyKindRef.current = policy.kind;
        // Update the snapshot so a subsequent userMovedCamera check
        // doesn't fire against the new pose's own delta.
        const pos = renderer.getCamera().getPosition();
        const tgt = renderer.getCamera().getTarget();
        cameraSnapshotRef.current = { px: pos.x, py: pos.y, pz: pos.z, tx: tgt.x, ty: tgt.y, tz: tgt.z };
        if (policy.kind === 'linear') notifyLinearFit();
      }
      geometryBoundsRef.current = exactBounds;
      // Refresh the camera's cached scene bounds with the FULL extent so
      // near/far clipping + section ranges still cover the far meshes;
      // the trimmed robust box only drives framing + the orbit anchor
      // (issues #1107 / #1394).
      renderer.getCamera().setSceneBounds(fullBounds ?? exactBounds);
      finalBoundsRefittedRef.current = true;
      tracePhaseOnce(trace, 'camera.refit').record('camera.refit', t0, performance.now(), { robust: robust !== null });
    }
  }

}
