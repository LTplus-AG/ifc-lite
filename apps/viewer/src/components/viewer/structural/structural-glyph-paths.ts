/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Screen-space SVG paths for structural glyphs (#9668): the drawing half of
 * the overlay adapter. Input is the parser's glyph list already moved into
 * the render frame (`toViewGlyphs`); output is one SVG `d` string per source
 * entity, rebuilt on every camera tick.
 *
 * Sizing: each symbol has a screen size in CSS px (readable at any zoom), but
 * never more than the screen length of `worldCap` metres at that point, so a
 * zoomed-out model is not buried under its own symbols. {@link MIN_PX} keeps a
 * far symbol visible.
 */

import { ifcToViewerAxes, totalYupOffset } from '@/lib/geo/coordinate-frame';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { StructuralGlyph, StructuralGlyphVec3 } from '@ifc-lite/parser/structural-glyphs';

export interface Vec3 { x: number; y: number; z: number }
interface Point { x: number; y: number }
export type Project = (p: Vec3) => Point | null;

/** A glyph in the render frame (Y up, the model's render offset removed). */
export interface ViewGlyph {
  glyph: StructuralGlyph;
  position: Vec3;
  direction: Vec3 | null;
}

/** Support symbol size, CSS px. */
const SUPPORT_PX = 18;
/** Arrow length for the largest load of its class, CSS px; the smallest is {@link ARROW_MIN_SHARE} of it. */
const ARROW_PX = 46;
const ARROW_MIN_SHARE = 0.35;
const MARKER_PX = 9;
/** Floor for any symbol, CSS px. */
export const MIN_PX = 6;

const vec = (p: StructuralGlyphVec3): Vec3 => ifcToViewerAxes({ x: p[0], y: p[1], z: p[2] });

/**
 * The parser's IFC-world glyphs in the render frame of the model they came
 * from: the same rule the model's IfcGrid and IfcAnnotation overlays use
 * (`lib/geo/ifc-origin.ts`): render = Y-up(world) - totalYupOffset.
 */
export function toViewGlyphs(glyphs: readonly StructuralGlyph[], coordinateInfo: CoordinateInfo | undefined): ViewGlyph[] {
  const offset = totalYupOffset(coordinateInfo);
  return glyphs.map((glyph) => {
    const p = vec(glyph.position);
    const direction = 'direction' in glyph && glyph.direction ? vec(glyph.direction) : null;
    return { glyph, position: { x: p.x - offset.x, y: p.y - offset.y, z: p.z - offset.z }, direction };
  });
}

const n = (v: number) => (Math.round(v * 10) / 10).toString();
const move = (p: Point) => `M${n(p.x)} ${n(p.y)}`;
const line = (p: Point) => `L${n(p.x)} ${n(p.y)}`;
const at = (o: Point, d: Point, along: number, across: number): Point =>
  ({ x: o.x + d.x * along - d.y * across, y: o.y + d.y * along + d.x * across });

/**
 * The on-screen unit direction and length of `worldLength` metres along
 * `direction` from `p`, or null when it cannot be projected. A direction
 * pointing at the camera has length near 0.
 */
function screenAxis(project: Project, position: Vec3, screen: Point, direction: Vec3, worldLength: number): { d: Point; px: number } | null {
  const q = project({ x: position.x + direction.x * worldLength, y: position.y + direction.y * worldLength, z: position.z + direction.z * worldLength });
  if (!q) return null;
  const dx = q.x - screen.x;
  const dy = q.y - screen.y;
  const px = Math.hypot(dx, dy);
  return { d: px > 1e-6 ? { x: dx / px, y: dy / px } : { x: 0, y: 1 }, px };
}

const sized = (wanted: number, worldPx: number) => Math.max(MIN_PX, Math.min(wanted, worldPx));

function arrowHead(tip: Point, d: Point, size: number, both = false): string {
  const h = Math.min(8, size * 0.35);
  const head = (o: Point, dir: Point) => `${move(at(o, dir, -h, h * 0.55))}${line(o)}${line(at(o, dir, -h, -h * 0.55))}`;
  return head(tip, d) + (both ? head(at(tip, d, -h * 0.8, 0), d) : '');
}

/** A support symbol hanging from the node against its frame's Z. */
function support(kind: string, p: Point, d: Point, s: number): string {
  const base = (along: number, half: number) => `${move(at(p, d, along, -half))}${line(at(p, d, along, half))}`;
  const triangle = `${move(p)}${line(at(p, d, s, -0.6 * s))}${line(at(p, d, s, 0.6 * s))}Z`;
  const hatch = (along: number, half: number) => [-1, -0.33, 0.33, 1]
    .map((f) => `${move(at(p, d, along, f * half))}${line(at(p, d, along + 0.3 * s, f * half - 0.3 * s))}`).join('');
  switch (kind) {
    case 'fixed': return `${move(p)}${line(at(p, d, 0.4 * s, 0))}${base(0.4 * s, 0.75 * s)}${hatch(0.4 * s, 0.75 * s)}`;
    case 'pinned': return `${triangle}${base(s, 0.8 * s)}${hatch(s, 0.8 * s)}`;
    case 'roller': return `${triangle}${base(1.3 * s, 0.8 * s)}`;
    default: {
      // Spring: a zigzag, then the ground line.
      const zig = [0.2, 0.35, 0.5, 0.65, 0.8].map((f, i) => line(at(p, d, f * s, (i % 2 ? -1 : 1) * 0.3 * s))).join('');
      return `${move(p)}${line(at(p, d, 0.1 * s, 0))}${zig}${line(at(p, d, s, 0))}${base(s, 0.7 * s)}`;
    }
  }
}

/**
 * One source's glyphs as one path. Forces end at the node (the arrow points
 * into it), so a row along a member also gets a line joining its tails: the
 * usual distributed-load diagram. `worldCap` is the largest a symbol may be,
 * in metres.
 */
export function glyphPath(glyphs: readonly ViewGlyph[], project: Project, worldCap: number): string {
  let out = '';
  const tails: Point[] = [];
  for (const { glyph, position, direction } of glyphs) {
    const p = project(position);
    if (!p) continue;
    if (glyph.kind === 'support') {
      const axis = direction && screenAxis(project, position, p, { x: -direction.x, y: -direction.y, z: -direction.z }, worldCap);
      const s = sized(SUPPORT_PX, axis?.px ?? SUPPORT_PX);
      // Looking straight along the support axis: hang it down the screen.
      out += support(glyph.support, p, axis && axis.px > MIN_PX ? axis.d : { x: 0, y: 1 }, s);
      continue;
    }
    if ((glyph.kind === 'force' || glyph.kind === 'moment' || glyph.kind === 'displacement') && direction) {
      const share = glyph.kind === 'displacement' ? 0.6 : ARROW_MIN_SHARE + (1 - ARROW_MIN_SHARE) * glyph.relative;
      const axis = screenAxis(project, position, p, direction, worldCap * share);
      if (!axis || axis.px < 1) {
        // Seen end-on: a ring at the node.
        out += circle(p, MARKER_PX / 2);
        continue;
      }
      const len = sized(ARROW_PX * share, axis.px);
      // A force points into its node; a moment or displacement vector starts at it.
      const intoNode = glyph.kind === 'force';
      const tail = intoNode ? at(p, axis.d, -len, 0) : p;
      const tip = intoNode ? p : at(p, axis.d, len, 0);
      out += `${move(tail)}${line(tip)}${arrowHead(tip, axis.d, len, glyph.kind === 'moment')}`;
      if (glyph.kind === 'force' && glyph.distribution === 'linear') tails.push(tail);
      continue;
    }
    if (glyph.kind === 'temperature') {
      out += `${circle(p, MARKER_PX / 2)}${move({ x: p.x, y: p.y - MARKER_PX })}${line({ x: p.x, y: p.y - MARKER_PX / 2 })}`;
      continue;
    }
    out += `${move({ x: p.x - MARKER_PX / 2, y: p.y - MARKER_PX / 2 })}h${MARKER_PX}v${MARKER_PX}h${-MARKER_PX}Z`;
  }
  // Join the tails of a distributed load in drawing order (the stations run along the member).
  if (tails.length > 1) out += tails.map((t, i) => (i ? line(t) : move(t))).join('');
  return out;
}

function circle(c: Point, r: number): string {
  return `${move({ x: c.x - r, y: c.y })}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`;
}
