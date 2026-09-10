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
 * yields `(renderX, renderZ)`, and `renderX = ifcX + shift.x`,
 * `renderZ = −ifcY + shift.z`. We invert that back to the room frame
 * `(ifcX, ifcY)` so the underlay overlays the rooms directly.
 *
 * The room frame is the model's OWN IFC frame, not the georeferenced one: a
 * `wasmRtcOffset` term here put the cut plane 381 m below a georeferenced
 * building, so the underlay came back empty on every storey — and an empty
 * underlay is indistinguishable from a storey that genuinely has no walls.
 * See the frame note in `lib/wall-rects-from-meshes.ts`, which this must stay
 * in step with or the underlay slides off the rooms it is drawn under.
 */

import { useEffect, useRef, useState } from 'react';
import { Drawing2DGenerator, createSectionConfig } from '@ifc-lite/drawing-2d';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { selectModelMeshes } from '@/lib/type-view-visibility';

export interface UnderlayLine {
  a: [number, number];
  b: [number, number];
  /** Dashed (above-cut / occluded) vs solid (at/below cut). */
  hidden: boolean;
}

export function useConstructionUnderlay(
  enabled: boolean,
  floorElevation: number | null,
): { lines: UnderlayLine[]; loading: boolean } {
  const geometryResult = useViewerStore((s) => s.geometryResult);
  const [lines, setLines] = useState<UnderlayLine[]>([]);
  const [loading, setLoading] = useState(false);
  const genRef = useRef<Drawing2DGenerator | null>(null);

  useEffect(() => {
    // Building elements only — the type library never belongs in a 2D
    // underlay any more than it belongs in a section (#2058).
    const meshes = geometryResult?.meshes ? selectModelMeshes(geometryResult.meshes) : undefined;
    if (!enabled || floorElevation === null || !meshes || meshes.length === 0) {
      setLines([]);
      return;
    }
    let cancelled = false;
    setLoading(true);

    const coord = geometryResult?.coordinateInfo as CoordinateInfo | undefined;
    const shift = coord?.originShift ?? { x: 0, y: 0, z: 0 };
    // Plan cut at floor + 1.2 m, in render-frame Y.
    const cutY = floorElevation + 1.2 + shift.y;
    // Inverse of the plan projection → room (ifcX, ifcY) frame.
    const cx = -shift.x;
    const cy = shift.z;

    const config = createSectionConfig('y', cutY, {
      projectionDepth: 1.5,
      projectionBelowDepth: 1.4,
      projectionAboveDepth: 0.8,
    });

    void (async () => {
      try {
        const gen = genRef.current ?? new Drawing2DGenerator();
        genRef.current = gen;
        await gen.initialize();
        const drawing = await gen.generate(meshes, config, {
          includeProjection: true,
          includeEdges: false,
          includeHiddenLines: false,
          mergeLines: true,
        });
        if (cancelled) return;
        const out: UnderlayLine[] = drawing.lines.map((l) => ({
          a: [l.line.start.x + cx, cy - l.line.start.y] as [number, number],
          b: [l.line.end.x + cx, cy - l.line.end.y] as [number, number],
          hidden: l.visibility === 'hidden',
        }));
        setLines(out);
      } catch (err) {
        // An empty underlay renders identically to "this storey genuinely has
        // no elements at the cut", so a failed generation is invisible in the
        // sketch. One line per (storey, geometry) change — not a render loop.
        console.warn('[underlay] construction underlay generation failed', err);
        if (!cancelled) setLines([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, floorElevation, geometryResult]);

  return { lines, loading };
}
