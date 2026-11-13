/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Linear dimensions on the 2D drawing canvas, in screen space.
 *
 * Geometry comes from the shared `dimensionGraphics` (the exports and the IFC
 * embed draw from the same function), mapped to pixels through the same
 * transform as the drawing (`drawingViewMapping`). The one screen-only change
 * is a legibility floor: text is drawn at least 11 px tall, and when that
 * floor applies it is pushed off the dimension line by its own height so it
 * never sits on the ticks.
 *
 * A dimension drawn on another cut (`isDimensionOnPlane` false) is drawn
 * dimmed and dashed; the panel names it on hover. The tool's live preview,
 * the snap glyph (one per snap mode) and the faint key-point markers near
 * the cursor are drawn here too.
 */

import type { SnapMode } from '@/lib/drafting-core/types';
import { dimensionGraphics, DIMENSION_PAPER_MM } from '@/lib/drawing2d-markup/dimension-graphics';
import type { DrawingViewMapping } from '@/lib/drawing2d-markup/drawing-view-mapping';
import { isDimensionOnPlane, type Dimension2D } from '@/store/slices/drawing2DDimensions';
import type { DrawnSectionPlane, Point2D } from '@/store/slices/drawing2DSlice';

/** Screen-only text floor in pixels (design: max(true size, 11 px)). */
export const DIMENSION_TEXT_MIN_PX = 11;

export interface DimensionLayoutContext {
  mapping: DrawingViewMapping;
  /** Drawing scale denominator: the sheet's when a sheet is shown, else the display scale. */
  paperScale: number;
  format: (metres: number) => string;
}

type Seg = [Point2D, Point2D];

export interface DimensionScreenLayout {
  lines: Seg[];
  ticks: Seg[];
  text: { at: Point2D; angle: number; fontPx: number; value: string };
}

export function dimensionScreenLayout(dim: Dimension2D, c: DimensionLayoutContext): DimensionScreenLayout {
  const g = dimensionGraphics(dim, { paperScale: c.paperScale, format: c.format, flip: c.mapping.flip });
  const map = (s: Seg): Seg => [c.mapping.toScreen(s[0]), c.mapping.toScreen(s[1])];
  const lines = g.lines.map(map);
  const truePx = g.text.heightM * c.mapping.pxPerMetre;
  const fontPx = Math.max(truePx, DIMENSION_TEXT_MIN_PX);
  let at = c.mapping.toScreen(g.text.at);
  if (fontPx > truePx) {
    // Re-centre the enlarged text: line midpoint + up × (gap + half height).
    const [p, q] = lines[0];
    const gapPx = Math.max((DIMENSION_PAPER_MM.textGap * c.paperScale / 1000) * c.mapping.pxPerMetre, 2);
    const up = { x: Math.sin(g.text.paperAngle), y: -Math.cos(g.text.paperAngle) };
    const d = gapPx + fontPx / 2;
    at = { x: (p.x + q.x) / 2 + up.x * d, y: (p.y + q.y) / 2 + up.y * d };
  }
  return { lines, ticks: g.ticks.map(map), text: { at, angle: g.text.paperAngle, fontPx, value: g.text.value } };
}

function distToSeg(p: Point2D, [a, b]: Seg): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether a screen point touches a laid-out dimension: a stroke within `threshold` px, or its text box. */
export function dimensionLayoutHit(layout: DimensionScreenLayout, p: Point2D, threshold: number): boolean {
  if ([...layout.lines, ...layout.ticks].some((s) => distToSeg(p, s) <= threshold)) return true;
  const { at, angle, fontPx, value } = layout.text;
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  const lx = (p.x - at.x) * cos - (p.y - at.y) * sin;
  const ly = (p.x - at.x) * sin + (p.y - at.y) * cos;
  // Width estimated from the glyph count: hit testing has no canvas to measure with.
  return Math.abs(lx) <= value.length * fontPx * 0.3 + 2 && Math.abs(ly) <= fontPx / 2 + 2;
}

/** The topmost (last drawn) dimension under a screen point. */
export function hitTestDimensions(dimensions: readonly Dimension2D[], p: Point2D, c: DimensionLayoutContext, threshold = 6): Dimension2D | null {
  for (let i = dimensions.length - 1; i >= 0; i--) {
    if (dimensionLayoutHit(dimensionScreenLayout(dimensions[i], c), p, threshold)) return dimensions[i];
  }
  return null;
}

export const DIMENSION_COLOR = '#1565C0';
const SELECTED_COLOR = '#1976D2';
const PREVIEW_COLOR = '#FF5722';
const SNAP_COLOR = '#2E7D32';

function strokeSegs(ctx: CanvasRenderingContext2D, segs: readonly Seg[]): void {
  ctx.beginPath();
  for (const [a, b] of segs) {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

interface DrawStyle { color: string; width: number; dash: number[]; alpha: number; halo?: boolean }

function drawLayout(ctx: CanvasRenderingContext2D, layout: DimensionScreenLayout, style: DrawStyle): void {
  ctx.save();
  ctx.globalAlpha = style.alpha;
  if (style.halo) {
    ctx.strokeStyle = 'rgba(25, 118, 210, 0.25)';
    ctx.lineWidth = style.width + 5;
    strokeSegs(ctx, [...layout.lines, ...layout.ticks]);
  }
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.setLineDash(style.dash);
  strokeSegs(ctx, layout.lines);
  ctx.lineWidth = style.width + 0.5;
  strokeSegs(ctx, layout.ticks);
  ctx.setLineDash([]);
  const { at, angle, fontPx, value } = layout.text;
  ctx.translate(at.x, at.y);
  ctx.rotate(angle);
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  ctx.fillStyle = style.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(value, 0, 0);
  ctx.restore();
}

/** One glyph per snap mode: square endpoint, triangle midpoint, X intersection, ⊥ perpendicular, diamond nearest. */
export function drawSnapGlyph(ctx: CanvasRenderingContext2D, p: Point2D, mode: SnapMode, r = 6): void {
  ctx.save();
  ctx.strokeStyle = SNAP_COLOR;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  switch (mode) {
    case 'endpoint':
      ctx.rect(p.x - r, p.y - r, 2 * r, 2 * r);
      break;
    case 'midpoint':
      ctx.moveTo(p.x, p.y - r);
      ctx.lineTo(p.x + r, p.y + r * 0.8);
      ctx.lineTo(p.x - r, p.y + r * 0.8);
      ctx.closePath();
      break;
    case 'intersection':
      ctx.moveTo(p.x - r, p.y - r); ctx.lineTo(p.x + r, p.y + r);
      ctx.moveTo(p.x + r, p.y - r); ctx.lineTo(p.x - r, p.y + r);
      break;
    case 'perpendicular':
      ctx.moveTo(p.x - r, p.y + r); ctx.lineTo(p.x + r, p.y + r);
      ctx.moveTo(p.x, p.y + r); ctx.lineTo(p.x, p.y - r);
      break;
    default:
      ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x + r, p.y);
      ctx.lineTo(p.x, p.y + r); ctx.lineTo(p.x - r, p.y);
      ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();
}

export interface DimensionScene {
  dimensions: readonly Dimension2D[];
  /** The plane drawn now; dimensions stamped with another are dimmed and dashed. */
  currentPlane: DrawnSectionPlane | null;
  selectedId: string | null;
  layout: DimensionLayoutContext;
  /** The tool's in-progress dimension. */
  preview?: Dimension2D | null;
  /** Measured points placed so far (drawing metres). */
  placedPoints?: readonly Point2D[];
  snap?: { point: Point2D; mode: SnapMode } | null;
  /** Endpoints and midpoints near the cursor (drawing metres), drawn faintly while the tool is active. */
  markers?: readonly Point2D[];
}

/** A screen-space clip rect: x, y, width, height in pixels. */
export type ScreenClipRect = readonly [number, number, number, number];

/**
 * Draw the scene. `clip` is the sheet viewport in sheet mode: dimensions are
 * drawing content and are clipped with it, never painted over the frame or
 * title block.
 */
export function drawDimensions2D(ctx: CanvasRenderingContext2D, scene: DimensionScene, clip: ScreenClipRect | null = null): void {
  if (!clip) {
    drawScene(ctx, scene);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(clip[0], clip[1], clip[2], clip[3]);
  ctx.clip();
  drawScene(ctx, scene);
  ctx.restore();
}

function drawScene(ctx: CanvasRenderingContext2D, scene: DimensionScene): void {
  const { mapping } = scene.layout;
  for (const dim of scene.dimensions) {
    const onPlane = isDimensionOnPlane(dim, scene.currentPlane);
    const selected = dim.id === scene.selectedId;
    drawLayout(ctx, dimensionScreenLayout(dim, scene.layout), {
      color: selected ? SELECTED_COLOR : DIMENSION_COLOR,
      width: selected ? 1.5 : 1,
      dash: onPlane ? [] : [5, 4],
      alpha: onPlane ? 1 : 0.45,
      halo: selected,
    });
  }

  if (scene.markers?.length) {
    ctx.save();
    ctx.fillStyle = 'rgba(46, 125, 50, 0.35)';
    for (const m of scene.markers) {
      const s = mapping.toScreen(m);
      ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
    }
    ctx.restore();
  }

  for (const p of scene.placedPoints ?? []) {
    const s = mapping.toScreen(p);
    ctx.save();
    ctx.fillStyle = PREVIEW_COLOR;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (scene.preview) {
    drawLayout(ctx, dimensionScreenLayout(scene.preview, scene.layout), { color: PREVIEW_COLOR, width: 1.5, dash: [], alpha: 1 });
  }
  if (scene.snap) drawSnapGlyph(ctx, mapping.toScreen(scene.snap.point), scene.snap.mode);
}
