/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The session's workplane, drawn faintly in 3D (charter #6232, M2 §1.4): a
 * dashed outline round the storey's plan (its walls, else the model's
 * bounds) plus 1 m, and a small cross at the storey origin, at the height
 * new elements land on. It answers "where will this go?" before the first
 * click. Mounted from `ToolOverlays` while the workspace is open, whatever
 * the tool; it lives in the scene's SVG layer, so leaving the workspace
 * unmounts it and nothing is left in the renderer.
 */

import { useMemo } from 'react';
import { useViewerStore, type ViewerState } from '@/store';
import { resolveWorkplane } from '@/lib/commands/modeling/registry';
import type { Vec2 } from '@/lib/snap/types';
import type { Workplane } from '@/lib/commands/modeling/types';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import { PlaneOutline } from '../../viewport-ui/scene';
import type { Vec3 as SceneVec3 } from '../../viewport-ui/scene/types';

const MARGIN_M = 1;
const TICK_M = 0.5;
/** A storey with nothing to measure gets a 10 m square round its origin. */
const EMPTY_HALF_M = 5;

interface Box { min: Vec2; max: Vec2 }

function grow(box: Box | null, p: Vec2): Box {
  if (!box) return { min: [p[0], p[1]], max: [p[0], p[1]] };
  return {
    min: [Math.min(box.min[0], p[0]), Math.min(box.min[1], p[1])],
    max: [Math.max(box.max[0], p[0]), Math.max(box.max[1], p[1])],
  };
}

/** The storey's plan extent in workplane-local metres: its wall axes, else the model's bounds. */
function storeyPlanBounds(s: ViewerState, plane: Workplane, storeyId: number): Box {
  const modelId = plane.modelId;
  const store = s.models.get(modelId)?.ifcDataStore;
  const view = s.mutationViews.get(modelId);
  let box: Box | null = null;
  if (store && view) {
    for (const axis of storeyWallAxes(store, view, storeyId)) box = grow(grow(box, axis.a), axis.b);
  }
  const bounds = box ? null : s.models.get(modelId)?.geometryResult?.coordinateInfo?.shiftedBounds;
  if (bounds && bounds.max.x > bounds.min.x) {
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const local = plane.renderToLocal([x, plane.plane.origin[1], z]);
        box = grow(box, [local[0], local[1]]);
      }
    }
  }
  return box ?? { min: [-EMPTY_HALF_M, -EMPTY_HALF_M], max: [EMPTY_HALF_M, EMPTY_HALF_M] };
}

interface WorkplaneOutline {
  corners: SceneVec3[];
  ticks: SceneVec3[][];
}

function workplaneOutline(s: ViewerState, plane: Workplane, storeyId: number): WorkplaneOutline {
  const { min, max } = storeyPlanBounds(s, plane, storeyId);
  const at = (x: number, y: number): SceneVec3 => {
    const [rx, ry, rz] = plane.localToRender([x, y, 0]);
    return { x: rx, y: ry, z: rz };
  };
  const [x0, y0, x1, y1] = [min[0] - MARGIN_M, min[1] - MARGIN_M, max[0] + MARGIN_M, max[1] + MARGIN_M];
  return {
    corners: [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)],
    // A polygon of [a, b, a] strokes as the segment a–b.
    ticks: [
      [at(-TICK_M, 0), at(TICK_M, 0), at(-TICK_M, 0)],
      [at(0, -TICK_M), at(0, TICK_M), at(0, -TICK_M)],
    ],
  };
}

export function WorkplaneScene() {
  const session = useViewerStore((s) => s.session);
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const placement = useViewerStore((s) => s.modelPlacement);
  const outline = useMemo(() => {
    void mutationVersion; // walls drawn or moved change the extent
    void placement;
    if (!session?.workplane || session.storeyId === null) return null;
    const s = useViewerStore.getState();
    const plane = resolveWorkplane(s, session.modelId, session.workplane);
    return 'refused' in plane ? null : workplaneOutline(s, plane, session.storeyId);
  }, [session?.modelId, session?.storeyId, session?.workplane, models, mutationVersion, placement]);

  if (!outline) return null;
  return (
    <>
      <PlaneOutline
        corners={outline.corners}
        allowOffscreen
        className="fill-none stroke-overlay-ink-muted/60 [stroke-dasharray:6_4]"
      />
      {outline.ticks.map((tick, i) => (
        <PlaneOutline key={i} corners={tick} allowOffscreen className="fill-none stroke-overlay-ink-muted/80" />
      ))}
    </>
  );
}
