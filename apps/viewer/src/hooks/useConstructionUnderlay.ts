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
 * render-frame meshes (Y-up, RTC-shifted). For a plan (down = `'y'`) cut,
 * `projectTo2D` yields `(renderX, renderZ)`, and `renderX = ifcX − rtc.x +
 * shift.x`, `renderZ = −ifcY + rtc.y + shift.z`. We invert that back to the
 * room frame `(ifcX, ifcY)` so the underlay overlays the rooms directly.
 */

import { useEffect, useRef, useState } from 'react';
import { Drawing2DGenerator, createSectionConfig } from '@ifc-lite/drawing-2d';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';

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
    const meshes = geometryResult?.meshes;
    if (!enabled || floorElevation === null || !meshes || meshes.length === 0) {
      setLines([]);
      return;
    }
    let cancelled = false;
    setLoading(true);

    const coord = geometryResult?.coordinateInfo as CoordinateInfo | undefined;
    const rtc = coord?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 };
    const shift = coord?.originShift ?? { x: 0, y: 0, z: 0 };
    // Plan cut at floor + 1.2 m, in render-frame Y.
    const cutY = floorElevation + 1.2 - rtc.z + shift.y;
    // Inverse of the plan projection → room (ifcX, ifcY) frame.
    const cx = rtc.x - shift.x;
    const cy = rtc.y + shift.z;

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
      } catch {
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
