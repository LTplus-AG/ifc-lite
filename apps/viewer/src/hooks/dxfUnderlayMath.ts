/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF underlay → 2D drawing space, pure mapping math (issue #1782).
 *
 * Converted DXF underlays are in world plan coordinates (metres, IFC XY —
 * DXF and IFC are both Z-up). The 2D drawing pipeline works in the render
 * frame: RTC/origin-shifted, projected via `projectTo2D` (plan:
 * `x_d = worldX`, `y_d = -worldY_ifc`), with a flipped section mirroring
 * X. These helpers apply that mapping, then the per-underlay placement
 * (offset/rotation/scale in drawing space), and filter by layer
 * visibility. Kept free of React/store imports so they are unit-testable;
 * the `useDxfUnderlaysForDrawing` hook wraps them.
 */

import { applyDxfPlacement, type DxfPlacement, type Point2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice';

export interface DxfUnderlayRenderLine {
  points: Point2D[];
  closed: boolean;
  color: string;
  widthMm?: number;
  dashed?: boolean;
}

export interface DxfUnderlayRenderFill {
  /** First loop is the outer ring; the rest are holes (even-odd fill). */
  loops: Point2D[][];
  color: string;
  /** True for pattern (non-SOLID) hatches, rendered translucent. */
  pattern: boolean;
}

export interface DxfUnderlayRenderText {
  x: number;
  y: number;
  /** Baseline direction in drawing space (screen-mapped later). */
  dirX: number;
  dirY: number;
  /** Text height in metres (world scale, placement applied). */
  height: number;
  text: string;
  color: string;
  align: 'left' | 'center' | 'right';
  valign: 'baseline' | 'bottom' | 'middle' | 'top';
}

/** One underlay pre-mapped to drawing space, ready for canvas/SVG. */
export interface DxfUnderlayRenderData {
  id: string;
  opacity: number;
  lines: DxfUnderlayRenderLine[];
  fills: DxfUnderlayRenderFill[];
  texts: DxfUnderlayRenderText[];
}

interface WorldToDrawingParams {
  shiftX: number;
  shiftY: number;
  mirrorX: boolean;
  placement: DxfPlacement;
}

function worldToDrawing(p: Point2D, t: WorldToDrawingParams): Point2D {
  // World → plan drawing space (render-frame shift + y-flip), then the
  // flipped-section mirror, then the user placement. Mirror-before-
  // placement keeps the placement offset in final drawing space, so
  // centre-on-model and the offset fields behave the same on flipped
  // sections.
  const x = p.x - t.shiftX;
  return applyDxfPlacement(
    { x: t.mirrorX ? -x : x, y: -(p.y - t.shiftY) },
    t.placement,
  );
}

/**
 * IFC-frame XY shift the render frame subtracts from world coordinates.
 * Per the canonical pipeline (reproject.ts computeModelCenterInIfcMeters):
 * `world_yup = render + originShift + rtc_as_yup`, so BOTH offsets combine.
 * The WASM RTC offset is in IFC Z-up (its IFC XY is `x, y`); the TS
 * `originShift` is Y-up (its IFC Y is `-z`).
 */
export function dxfWorldShift(coordinateInfo: GeometryResult['coordinateInfo'] | undefined): { x: number; y: number } {
  const rtc = coordinateInfo?.wasmRtcOffset;
  const shift = coordinateInfo?.originShift;
  return {
    x: (rtc?.x ?? 0) + (shift?.x ?? 0),
    y: (rtc?.y ?? 0) - (shift?.z ?? 0),
  };
}

/** Map one underlay entry to drawing space, honouring layer visibility. */
export function dxfUnderlayToDrawing(
  entry: DxfUnderlayState,
  shift: { x: number; y: number },
  mirrorX: boolean,
): DxfUnderlayRenderData {
  const t: WorldToDrawingParams = {
    shiftX: shift.x,
    shiftY: shift.y,
    mirrorX,
    placement: entry.placement,
  };
  const lines: DxfUnderlayRenderLine[] = [];
  const fills: DxfUnderlayRenderFill[] = [];
  const texts: DxfUnderlayRenderText[] = [];

  for (const layer of entry.underlay.layers) {
    if (!(entry.layerVisibility[layer.name] ?? layer.visible)) continue;

    for (const path of layer.paths) {
      if (path.points.length < 2) continue;
      lines.push({
        points: path.points.map((p) => worldToDrawing(p, t)),
        closed: path.closed,
        color: path.color ?? layer.color,
        widthMm: path.widthMm,
        dashed: path.dashed,
      });
    }
    for (const fill of layer.fills) {
      const loops = [fill.polygon.outer, ...fill.polygon.holes]
        .filter((ring) => ring.length >= 3)
        .map((ring) => ring.map((p) => worldToDrawing(p, t)));
      if (loops.length === 0) continue;
      fills.push({ loops, color: fill.color ?? layer.color, pattern: fill.pattern });
    }
    for (const text of layer.texts) {
      if (!text.text.trim()) continue;
      const anchor = worldToDrawing(text.position, t);
      const tip = worldToDrawing(
        { x: text.position.x + text.dirX, y: text.position.y + text.dirY },
        t,
      );
      texts.push({
        x: anchor.x,
        y: anchor.y,
        dirX: tip.x - anchor.x,
        dirY: tip.y - anchor.y,
        height: text.height * entry.placement.scale,
        text: text.text,
        color: text.color ?? layer.color,
        align: text.align,
        valign: text.valign,
      });
    }
  }
  return { id: entry.id, opacity: entry.opacity, lines, fills, texts };
}

/** Drawing-space bounds of an underlay at zero offset (for centre-on-model). */
export function dxfUnderlayDrawingBounds(
  entry: DxfUnderlayState,
  shift: { x: number; y: number },
  mirrorX: boolean,
): { min: Point2D; max: Point2D } | null {
  const b = entry.underlay.bounds;
  if (!b) return null;
  const t: WorldToDrawingParams = {
    shiftX: shift.x,
    shiftY: shift.y,
    mirrorX,
    placement: { ...entry.placement, offsetX: 0, offsetY: 0 },
  };
  // Rotation in the placement makes axis-aligned min/max insufficient:
  // map all four corners.
  const corners = [
    worldToDrawing({ x: b.min.x, y: b.min.y }, t),
    worldToDrawing({ x: b.max.x, y: b.min.y }, t),
    worldToDrawing({ x: b.max.x, y: b.max.y }, t),
    worldToDrawing({ x: b.min.x, y: b.max.y }, t),
  ];
  return {
    min: { x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)) },
    max: { x: Math.max(...corners.map((c) => c.x)), y: Math.max(...corners.map((c) => c.y)) },
  };
}

