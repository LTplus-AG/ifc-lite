/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF underlay → 2D drawing space, pure mapping math (issue #1782).
 *
 * Converted DXF underlays are, BY DEFAULT, assumed to already be in world
 * plan coordinates (metres, IFC XY — DXF and IFC are both Z-up). The 2D
 * drawing pipeline works in the render frame: RTC/origin-shifted, projected
 * via `projectTo2D` (plan: `x_d = worldX`, `y_d = -worldY_ifc`), with a
 * flipped section mirroring X. These helpers apply that mapping, then the
 * per-underlay placement (offset/rotation/scale in drawing space), and
 * filter by layer visibility. Kept free of React/store imports so they are
 * unit-testable; the `useDxfUnderlaysForDrawing` hook wraps them.
 *
 * Issue #1929 challenges the "already in world coordinates" assumption: a
 * surveyor's DXF is typically drawn in map/CRS coordinates (eastings,
 * northings), not the IFC model's local frame. When a per-underlay entry's
 * EFFECTIVE `georeferenced` state is true, the underlay's raw coordinates
 * are first passed through a caller-supplied `mapToWorld` transform — the
 * inverse IfcMapConversion, built by `dxfExportGeoref.ts`'s
 * `buildDxfMapToWorldTransform` — before the world→drawing mapping below
 * runs.
 *
 * `entry.georeferenced` is TRI-STATE (PR #1965 review, closing an import
 * race — see `dxfIngest.ts`'s module doc for the full race description):
 *   - `true` / `false`: explicit, only ever written by the user flipping
 *     the "Align to model georeference" checkbox
 *     (`setDxfUnderlayGeoreferenced`). Always wins regardless of anchor
 *     availability.
 *   - `undefined` ("auto"): follow anchor georeference availability,
 *     resolved HERE at render/call time via the `georeferenceAvailable`
 *     parameter — not baked in at import time. `resolveEffectiveGeoreferenced`
 *     below is the single place that resolves the tri-state.
 * `addDxfUnderlay` (drawing2DSlice.ts) defaults an entry's `georeferenced`
 * to `false`, NOT auto, unless the caller explicitly opts into `'auto'` —
 * so anything constructing an entry outside the DXF-ingest feature
 * (including a hypothetical future load/migration path for entries that
 * predate this issue) is conservative by construction: it never starts
 * following the anchor's georeference on its own. Only `ingestDxfFile`
 * opts a freshly-imported entry into `'auto'`. That is how "created before
 * this feature existed" (`false`) stays distinct from "created by this
 * feature in auto mode" (`undefined`) even though both currently apply the
 * SAME identity transform the instant a session starts with no anchor
 * georeference loaded — the difference only shows up once a georeferenced
 * model appears, at which point auto entries follow it and explicit-`false`
 * entries do not, by design.
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
  /**
   * Map/CRS-space → IFC-world-space transform, applied BEFORE the
   * render-frame shift below (issue #1929). `undefined` when the entry
   * isn't georeferenced (or no anchor georeference is available) — the
   * point is used as-is, exactly like before this issue.
   */
  mapToWorld?: (p: Point2D) => Point2D;
}

function worldToDrawing(p: Point2D, t: WorldToDrawingParams): Point2D {
  // Map/CRS → IFC world (issue #1929), only for underlays flagged
  // georeferenced. Then: world → plan drawing space (render-frame shift +
  // y-flip), then the flipped-section mirror, then the user placement.
  // Mirror-before-placement keeps the placement offset in final drawing
  // space, so centre-on-model and the offset fields behave the same on
  // flipped sections.
  const world = t.mapToWorld ? t.mapToWorld(p) : p;
  const x = world.x - t.shiftX;
  return applyDxfPlacement(
    { x: t.mirrorX ? -x : x, y: -(world.y - t.shiftY) },
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

/**
 * Resolve an underlay entry's TRI-STATE `georeferenced` field to the actual
 * boolean the world→drawing mapping applies (PR #1965 review). `true` /
 * `false` are explicit (the user toggled the checkbox) and always win;
 * `undefined` ("auto") follows whether the caller currently has an anchor
 * `mapToWorld` transform available (`georeferenceAvailable` — see
 * `useDxfMapToWorldTransform`'s `available` flag). Shared by
 * `dxfUnderlayToDrawing`, `dxfUnderlayDrawingBounds`, and the underlay
 * panel checkbox (`DxfUnderlayPanel.tsx`) so all three can never disagree
 * about what "on" currently means for an auto entry.
 */
export function resolveEffectiveGeoreferenced(
  entry: Pick<DxfUnderlayState, 'georeferenced'>,
  georeferenceAvailable: boolean,
): boolean {
  return entry.georeferenced ?? georeferenceAvailable;
}

/**
 * Map one underlay entry to drawing space, honouring layer visibility.
 *
 * `mapToWorld` (issue #1929) is the resolved inverse-IfcMapConversion
 * transform (or identity, when unavailable); it is only actually applied
 * when the entry's EFFECTIVE georeferenced state
 * ({@link resolveEffectiveGeoreferenced}) is true, so callers can pass the
 * same transform for every underlay regardless of each one's toggle state.
 * `georeferenceAvailable` defaults to `false` so an omitted 5th argument
 * reproduces the pre-tri-state behaviour exactly (an `undefined`-flagged
 * entry stays off) — existing callers/tests that only ever set
 * `entry.georeferenced` explicitly are unaffected.
 */
export function dxfUnderlayToDrawing(
  entry: DxfUnderlayState,
  shift: { x: number; y: number },
  mirrorX: boolean,
  mapToWorld: (p: Point2D) => Point2D = (p) => p,
  georeferenceAvailable = false,
): DxfUnderlayRenderData {
  const t: WorldToDrawingParams = {
    shiftX: shift.x,
    shiftY: shift.y,
    mirrorX,
    placement: entry.placement,
    mapToWorld: resolveEffectiveGeoreferenced(entry, georeferenceAvailable) ? mapToWorld : undefined,
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

/**
 * Drawing-space bounds of an underlay at zero offset (for centre-on-model).
 * `georeferenceAvailable` — see {@link resolveEffectiveGeoreferenced} —
 * defaults to `false` for the same backward-compat reason as
 * {@link dxfUnderlayToDrawing}.
 *
 * Returns `null` (not NaN bounds) whenever any corner is non-finite (PR
 * #1965 review): a malformed `IfcMapConversion` that slips a NaN into
 * `mapToWorld` used to make `Math.min`/`Math.max` return NaN silently, and
 * the caller (`Section2DPanel.handleCenterDxfUnderlay`) would then write
 * `offsetX: NaN, offsetY: NaN` straight into the stored placement — a
 * corruption that survives even toggling georeferencing back off, since the
 * NaN is now IN the placement, not just in the transform. A NaN bound is a
 * lie about the data; null says "can't centre this" instead, which is true.
 */
export function dxfUnderlayDrawingBounds(
  entry: DxfUnderlayState,
  shift: { x: number; y: number },
  mirrorX: boolean,
  mapToWorld: (p: Point2D) => Point2D = (p) => p,
  georeferenceAvailable = false,
): { min: Point2D; max: Point2D } | null {
  const b = entry.underlay.bounds;
  if (!b) return null;
  const t: WorldToDrawingParams = {
    shiftX: shift.x,
    shiftY: shift.y,
    mirrorX,
    placement: { ...entry.placement, offsetX: 0, offsetY: 0 },
    mapToWorld: resolveEffectiveGeoreferenced(entry, georeferenceAvailable) ? mapToWorld : undefined,
  };
  // Rotation in the placement makes axis-aligned min/max insufficient:
  // map all four corners.
  const corners = [
    worldToDrawing({ x: b.min.x, y: b.min.y }, t),
    worldToDrawing({ x: b.max.x, y: b.min.y }, t),
    worldToDrawing({ x: b.max.x, y: b.max.y }, t),
    worldToDrawing({ x: b.min.x, y: b.max.y }, t),
  ];
  const minX = Math.min(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxX = Math.max(...corners.map((c) => c.x));
  const maxY = Math.max(...corners.map((c) => c.y));
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

