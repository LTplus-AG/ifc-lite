/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Faint plan-cut underlay of building elements (walls/doors/columns ~1.2 m
 * above the storey floor) for the 2D Space Sketch, registered into the same
 * model-metre frame as the room outlines so the user keeps building orientation
 * while editing rooms.
 *
 * The construction projection (the same one the sections canvas uses) runs on
 * render-frame meshes (Y-up). For a plan (down = `'y'`) cut, `projectTo2D`
 * yields `(renderX, renderZ)`, and `renderX = ifcX − shift.x`,
 * `renderZ = −ifcY − shift.z` (render = ifc − originShift, the
 * `createCoordinateInfo` invariant). We invert that back to the room frame
 * `(ifcX, ifcY)` so the underlay overlays the rooms directly.
 *
 * The room frame is the model's OWN IFC frame, not the georeferenced one: a
 * `wasmRtcOffset` term here put the cut plane 381 m below a georeferenced
 * building, so the underlay came back empty on every storey — and an empty
 * underlay is indistinguishable from a storey that genuinely has no walls.
 * See the frame note in `lib/wall-rects-from-meshes.ts`, which this must stay
 * in step with or the underlay slides off the rooms it is drawn under.
 */

import { useMemo } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { selectModelMeshes } from '@/lib/type-view-visibility';
import { roomFramePlanOffsets } from '@/lib/wall-rects-from-meshes';
import { PLAN_CUT_HEIGHT, identityKey, usePlanCutDrawing, type PlanCutRequest } from '@/components/viewer/plan/usePlanCut';

export interface UnderlayLine {
  a: [number, number];
  b: [number, number];
  /** Dashed (above-cut / occluded) vs solid (at/below cut). */
  hidden: boolean;
}

/**
 * The cut itself is the Model workspace plan's (`usePlanCutDrawing`: one
 * plan-cut path, debounced and superseded the same way); this hook only
 * supplies the room frame and keeps the lines.
 */
export function useConstructionUnderlay(
  enabled: boolean,
  floorElevation: number | null,
): { lines: UnderlayLine[]; loading: boolean } {
  const geometryResult = useViewerStore((s) => s.geometryResult);

  const request = useMemo<PlanCutRequest | null>(() => {
    // Building elements only — the type library never belongs in a 2D
    // underlay any more than it belongs in a section (#2058).
    const meshes = geometryResult?.meshes ? selectModelMeshes(geometryResult.meshes) : undefined;
    if (!enabled || floorElevation === null || !geometryResult || !meshes || meshes.length === 0) return null;
    const coord = geometryResult.coordinateInfo as CoordinateInfo | undefined;
    const shift = coord?.originShift ?? { x: 0, y: 0, z: 0 };
    // Plan cut at floor + 1.2 m, in render-frame Y: renderY = ifcZ − shift.y
    // (the same band arithmetic as `wallRectsFromMeshes`).
    const cutY = floorElevation + PLAN_CUT_HEIGHT - shift.y;
    // Inverse of the plan projection → room (ifcX, ifcY) frame, taken from
    // the one place the room frame is defined so the two cannot drift.
    const { cx, cy } = roomFramePlanOffsets(coord);
    return {
      key: `underlay:${identityKey(geometryResult)}:${meshes.length}:${cutY}`,
      meshes,
      cutY,
      map: (x, z) => [x + cx, cy - z],
    };
  }, [enabled, floorElevation, geometryResult]);

  const cut = usePlanCutDrawing(request);
  const lines = useMemo<UnderlayLine[]>(
    () => cut.lines.map((l) => ({ a: [l.a[0], l.a[1]], b: [l.b[0], l.b[1]], hidden: l.hidden })),
    [cut.lines],
  );
  return { lines, loading: cut.loading };
}
