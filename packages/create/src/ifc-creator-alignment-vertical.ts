/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcAlignmentVertical` emitter (mapping spec §12) — the vertical half of an
 * `IfcAlignment`, called from `emitAlignment`.
 *
 * Writes both halves IFC 4.3 defines: the semantic layout (`IfcAlignmentVertical`
 * nesting `IfcAlignmentSegment`s) and the geometry (`IfcGradientCurve` over the
 * horizontal `IfcCompositeCurve`). Each `IfcCurveSegment` follows IfcOpenShell
 * 0.8.5's `_map_alignment_vertical_segment` exactly, computed from the design
 * parameters alone, so the geometry is the one a consumer derives from the
 * semantics.
 */

import { esc, num } from './ifc-creator-math.js';
import { ALIGNMENT_POSITION_TOLERANCE_M } from './landxml/alignment-mapping.js';
import { evaluateVertical, type VerticalSegment } from './landxml/profile-geometry.js';

/** The creator hooks this emitter needs (a subset of `AlignmentContext`). */
export interface VerticalContext {
  emit: (type: string, attrs: string) => number;
  ownerRef: string;
}

/** A vertical layout for `AlignmentParams.Vertical`. Distances and heights in metres. */
export interface AlignmentVerticalParams {
  Name?: string;
  GlobalId?: string;
  /** In order along the alignment; the zero-length terminator is added here. */
  Segments: readonly VerticalSegment[];
}

const allclose = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-8 + 1e-5 * Math.abs(b);

/** Curvature of the distance/height curve: `y'' / (1 + y'²)^1.5` for a parabola. */
function curvature(segment: VerticalSegment, x: number): number {
  if (segment.type === 'CONSTANTGRADIENT' || segment.horizontalLength === 0) return 0;
  if (segment.type === 'CIRCULARARC') return 1 / (segment.radiusOfCurvature ?? Infinity);
  const g = evaluateVertical(segment, x).gradient;
  const second = (segment.endGradient - segment.startGradient) / segment.horizontalLength;
  return second / (1 + g * g) ** 1.5;
}

function transitionCode(segment: VerticalSegment, next: VerticalSegment): string {
  const end = evaluateVertical(segment, segment.horizontalLength);
  const samePosition = Math.abs(segment.startDistAlong + segment.horizontalLength - next.startDistAlong) <= ALIGNMENT_POSITION_TOLERANCE_M
    && Math.abs(end.height - next.startHeight) <= ALIGNMENT_POSITION_TOLERANCE_M;
  if (!samePosition) return '.DISCONTINUOUS.';
  const a = Math.atan(end.gradient);
  const b = Math.atan(next.startGradient);
  if (!(allclose(Math.cos(a), Math.cos(b)) && allclose(Math.sin(a), Math.sin(b)))) return '.CONTINUOUS.';
  return allclose(curvature(segment, segment.horizontalLength), curvature(next, 0))
    ? '.CONTSAMEGRADIENTSAMECURVATURE.' : '.CONTSAMEGRADIENT.';
}

/**
 * Arc length of `A + Bx + Cx²` over `[0, L]`.
 *
 * IfcOpenShell's `_polynomial_length` closed form, where it is well
 * conditioned. Its terms grow like `1/C` and cancel, so as `C·L` shrinks the
 * result loses digits (1e-9 relative by `C·L = 1e-7`) and at `C ≈ 1e-19`
 * returns 0 for an 80 m curve (#5930 review). Below `|C·L| = 1e-5` — where the
 * closed form is still good to ~1e-11 — the nearly constant integrand
 * `sqrt(1 + (B + 2Cx)²)` is integrated by Simpson's rule instead, exact to
 * rounding for so gentle a curve.
 */
export function polynomialLength(B: number, C: number, L: number): number {
  if (Math.abs(C * L) < 1e-5) {
    const steps = 64;
    const h = L / steps;
    let sum = 0;
    for (let i = 0; i <= steps; i += 1) {
      const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
      const slope = B + 2 * C * i * h;
      sum += weight * Math.sqrt(1 + slope * slope);
    }
    return (sum * h) / 3;
  }
  const a = 4 * C * C;
  const b = 4 * B * C;
  const c = B * B + 1;
  const fn = (x: number): number => {
    const v1 = (b + 2 * a * x) / (4 * a);
    const v2 = Math.sqrt(a * x * x + b * x + c);
    const v3 = (4 * a * c - b * b) / (8 * a ** 1.5);
    const v4 = Math.log(Math.abs(2 * a * x + b + 2 * Math.sqrt(a * (a * x * x + b * x + c))));
    return v1 * v2 + v3 * v4;
  };
  return fn(L) - fn(0);
}

function point2d(ctx: VerticalContext, x: number, y: number): number {
  return ctx.emit('IFCCARTESIANPOINT', `(${num(x)},${num(y)})`);
}

function direction2d(ctx: VerticalContext, x: number, y: number): number {
  return ctx.emit('IFCDIRECTION', `(${num(x)},${num(y)})`);
}

/** `IfcCurveSegment` for one vertical segment — IfcOpenShell's mapping, term for term. */
function curveSegment(ctx: VerticalContext, segment: VerticalSegment, transition: string): number {
  const { startDistAlong: d, horizontalLength: L, startHeight: h, startGradient: g0, endGradient: g1 } = segment;
  const placement = ctx.emit(
    'IFCAXIS2PLACEMENT2D',
    `#${point2d(ctx, d, h)},#${direction2d(ctx, Math.cos(Math.atan(g0)), Math.sin(Math.atan(g0)))}`,
  );
  let parent: number;
  let segmentStart = 0;
  let segmentLength: number;
  if (segment.type === 'CONSTANTGRADIENT') {
    const vector = ctx.emit('IFCVECTOR', `#${direction2d(ctx, 1, 0)},1.`);
    parent = ctx.emit('IFCLINE', `#${point2d(ctx, 0, 0)},#${vector}`);
    segmentLength = L / Math.cos(Math.atan(g0));
  } else if (segment.type === 'PARABOLICARC') {
    const C = (g1 - g0) / (2 * L);
    const position = ctx.emit('IFCAXIS2PLACEMENT2D', `#${point2d(ctx, 0, 0)},#${direction2d(ctx, 1, 0)}`);
    parent = ctx.emit('IFCPOLYNOMIALCURVE', `#${position},(0.,1.),(${num(h)},${num(g0)},${num(C)}),$`);
    segmentLength = polynomialLength(g0, C, L);
  } else {
    let startAngle = Math.atan(g0);
    let endAngle = Math.atan(g1);
    let radius: number;
    let x: number;
    let y: number;
    if (startAngle < endAngle) {
      radius = L / (Math.sin(endAngle) - Math.sin(startAngle));
      x = -radius * Math.sin(startAngle);
      y = radius * Math.cos(startAngle);
      startAngle += (3 * Math.PI) / 2;
      endAngle += (3 * Math.PI) / 2;
    } else {
      radius = L / (Math.sin(startAngle) - Math.sin(endAngle));
      x = radius * Math.sin(startAngle);
      y = -radius * Math.cos(startAngle);
      startAngle += Math.PI / 2;
      endAngle += Math.PI / 2;
    }
    const position = ctx.emit('IFCAXIS2PLACEMENT2D', `#${point2d(ctx, x, y)},#${direction2d(ctx, 1, 0)}`);
    parent = ctx.emit('IFCCIRCLE', `#${position},${num(radius)}`);
    segmentStart = radius * startAngle;
    segmentLength = radius * (endAngle - startAngle);
  }
  return ctx.emit(
    'IFCCURVESEGMENT',
    `${transition},#${placement},IFCLENGTHMEASURE(${num(segmentStart)}),IFCLENGTHMEASURE(${num(segmentLength)}),#${parent}`,
  );
}

/** The zero-length `CONSTANTGRADIENT` IFC 4.3 requires at the end of every layout. */
function terminator(last: VerticalSegment): VerticalSegment {
  const end = evaluateVertical(last, last.horizontalLength);
  return {
    sourceId: `${last.sourceId}:end`, type: 'CONSTANTGRADIENT',
    startDistAlong: last.startDistAlong + last.horizontalLength, horizontalLength: 0,
    startHeight: end.height, startGradient: end.gradient, endGradient: end.gradient, radiusOfCurvature: null,
  };
}

function layoutOf(params: AlignmentVerticalParams): VerticalSegment[] {
  if (params.Segments.length === 0) {
    throw new Error('addAlignment: Vertical.Segments is empty — a vertical layout needs at least one segment');
  }
  // As `emitAlignment` does for the horizontal: a gap would be a mid-curve
  // `.DISCONTINUOUS.`, which `IfcCompositeCurve.CurveContinuous` forbids for an
  // open curve (exactly one, the last).
  params.Segments.slice(1).forEach((next, index) => {
    const previous = params.Segments[index];
    const end = evaluateVertical(previous, previous.horizontalLength);
    const distGap = Math.abs(previous.startDistAlong + previous.horizontalLength - next.startDistAlong);
    const heightGap = Math.abs(end.height - next.startHeight);
    if (distGap > ALIGNMENT_POSITION_TOLERANCE_M || heightGap > ALIGNMENT_POSITION_TOLERANCE_M) {
      throw new Error(
        `addAlignment: vertical segment ${index + 2} starts ${distGap.toFixed(3)} m along and `
        + `${heightGap.toFixed(3)} m in height from where segment ${index + 1} ends; `
        + 'an open IfcGradientCurve may be discontinuous only at its last segment',
      );
    }
  });
  return [...params.Segments, terminator(params.Segments[params.Segments.length - 1])];
}

/**
 * The `IfcGradientCurve` over `compositeCurveId`, one curve segment per layout
 * segment, the last `DISCONTINUOUS` (`IfcCompositeCurve.CurveContinuous`).
 */
export function emitGradientCurve(ctx: VerticalContext, params: AlignmentVerticalParams, compositeCurveId: number): number {
  const layout = layoutOf(params);
  const segments = layout.map((segment, index) => curveSegment(
    ctx, segment, index === layout.length - 1 ? '.DISCONTINUOUS.' : transitionCode(segment, layout[index + 1]),
  ));
  return ctx.emit('IFCGRADIENTCURVE', `(${segments.map((id) => `#${id}`).join(',')}),.F.,#${compositeCurveId},$`);
}

/**
 * The semantic layout: `IfcAlignmentVertical` and its segments, nested in
 * order. The caller nests the layout itself under the alignment, beside the
 * horizontal one.
 */
export function emitVerticalLayout(
  ctx: VerticalContext, params: AlignmentVerticalParams, guid: (role: string) => string,
): { verticalId: number; segmentIds: number[] } {
  const verticalId = ctx.emit(
    'IFCALIGNMENTVERTICAL',
    `'${params.GlobalId ?? guid('vertical')}',${ctx.ownerRef},${params.Name !== undefined ? `'${esc(params.Name)}'` : '$'},$,$,$,$`,
  );
  const segmentIds = layoutOf(params).map((segment, index) => {
    const design = ctx.emit(
      'IFCALIGNMENTVERTICALSEGMENT',
      `$,$,${num(segment.startDistAlong)},${num(segment.horizontalLength)},${num(segment.startHeight)},`
      + `${num(segment.startGradient)},${num(segment.endGradient)},`
      + `${segment.radiusOfCurvature === null ? '$' : num(segment.radiusOfCurvature)},.${segment.type}.`,
    );
    return ctx.emit('IFCALIGNMENTSEGMENT', `'${guid(`vertical:segment:${index}`)}',${ctx.ownerRef},$,$,$,$,$,#${design}`);
  });
  ctx.emit('IFCRELNESTS', `'${guid('nests:vertical-segments')}',${ctx.ownerRef},$,$,#${verticalId},(${segmentIds.map((id) => `#${id}`).join(',')})`);
  return { verticalId, segmentIds };
}
