/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { activeLoadTrace, tracePhaseOnce } from '@/lib/perf/activeLoadTrace';
import { robustFitBoundsFull } from './robustFitBoundsAccumulator.js';
import { userMovedCamera, type Bounds } from './streamingBounds.js';

interface FitParams {
  renderer: Renderer;
  cameraFittedRef: MutableRefObject<boolean>;
  cameraSnapshotRef: MutableRefObject<Parameters<typeof userMovedCamera>[1]>;
  geometryBoundsRef: MutableRefObject<Bounds>;
  finalBoundsRefittedRef: MutableRefObject<boolean>;
  lastFitPolicyKindRef: MutableRefObject<'compact' | 'linear' | null>;
  complete: boolean;
}

/** #7955: called only after a shard-only arrival (or its empty-flat completion).
 * Use renderer-owned, already transformed bounds; never compose another frame. */
export function fitInstanceOnlyBounds(p: FitParams): void {
  if (p.complete ? !p.cameraFittedRef.current || p.finalBoundsRefittedRef.current : p.cameraFittedRef.current) return;
  const scene = p.renderer.getScene();
  const boxes = Array.from(scene.getInstancedEntityIds()).flatMap(id => {
    const b = scene.getInstancedEntityBounds(id);
    return b ? [{ positions: Float64Array.of(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z) }] : [];
  });
  const bounds = robustFitBoundsFull(boxes, { quiet: true });
  if (!bounds) return;
  const fit = bounds.robust ?? bounds.full;
  const started = performance.now(), camera = p.renderer.getCamera();
  if (!p.complete || !userMovedCamera(p.renderer, p.cameraSnapshotRef.current)) {
    const canvas = p.renderer.getCanvas();
    const short = Math.min(canvas?.clientHeight ?? 0, canvas?.clientWidth ?? 0);
    const policy = camera.fitBoundsAdaptive(fit, { viewportShortPx: short > 0 ? short : undefined });
    p.lastFitPolicyKindRef.current = policy.kind;
    const pos = camera.getPosition(), target = camera.getTarget();
    p.cameraSnapshotRef.current = { px: pos.x, py: pos.y, pz: pos.z, tx: target.x, ty: target.y, tz: target.z };
  }
  camera.setSceneBounds(bounds.full);
  camera.setOrbitAnchorBounds(bounds.robust);
  p.geometryBoundsRef.current = fit;
  p.cameraFittedRef.current = true;
  if (p.complete) p.finalBoundsRefittedRef.current = true;
  const phase = p.complete ? 'camera.refit' : 'camera.fit';
  tracePhaseOnce(activeLoadTrace(), phase).record(phase, started, performance.now(), { instancedOnly: true });
}
