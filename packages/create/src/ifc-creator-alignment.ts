/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcAlignment` emitter — horizontal layout (mapping spec §11), plus the
 * vertical layout from `ifc-creator-alignment-vertical.ts` when given (§12).
 *
 * Writes BOTH halves IFC 4.3 defines for an alignment: the semantic layout
 * (`IfcAlignmentHorizontal` nesting `IfcAlignmentSegment`s) and the geometry
 * (`IfcCompositeCurve` of `IfcCurveSegment`s). The structure mirrors what
 * IfcOpenShell 0.8.5's `alignment` API writes for the same input, and each
 * `IfcCurveSegment` follows its `_map_alignment_horizontal_segment` exactly —
 * so the geometry is the one a consumer would derive from the semantics.
 *
 * Parameters arrive already mapped (`landxml/alignment-mapping.ts`): metres,
 * radians counter-clockwise from +X, radii positive for a counter-clockwise
 * turn and `0` for infinite.
 */

import { esc, num } from './ifc-creator-math.js';
import { ALIGNMENT_POSITION_TOLERANCE_M, type HorizontalSegment } from './landxml/alignment-mapping.js';
import { emitGradientCurve, emitVerticalLayout, type AlignmentVerticalParams } from './ifc-creator-alignment-vertical.js';
import { emitStationing, type StationEquationParams } from './ifc-creator-alignment-referents.js';

/** The creator hooks this emitter needs. */
export interface AlignmentContext {
  emit: (type: string, attrs: string) => number;
  newGlobalId: () => string;
  ownerRef: string;
  /** `#<id>` of the `'Axis'` representation subcontext. */
  axisContextRef: string;
  /** `#<id>` of the world placement the alignment hangs from. */
  placementRef: string;
}

export interface AlignmentParams {
  Name: string;
  GlobalId?: string;
  /** Station at distance 0, metres — written to the start referent's `Pset_Stationing`. */
  StartStation: number;
  Segments: readonly HorizontalSegment[];
  /**
   * The vertical layout (mapping spec §12). When present the alignment also
   * gets an `IfcAlignmentVertical` and an `IfcGradientCurve` 'Axis'
   * representation, and the composite curve moves to 'FootPrint'.
   */
  Vertical?: AlignmentVerticalParams;
  /** Station equations (§14), in order along the alignment; each becomes an `IfcReferent`. */
  StationEquations?: readonly StationEquationParams[];
  /** Deterministic GlobalId seed for this alignment's owned entities. */
  guidFor?: (role: string) => string;
}

export interface AlignmentResult {
  alignmentId: number;
  horizontalId: number;
  compositeCurveId: number;
  /** `IfcAlignmentSegment` ids in order, including the terminating one. */
  segmentIds: number[];
  referentId: number;
  /** Present when `Vertical` was given. */
  verticalId?: number;
  gradientCurveId?: number;
  /** One `IfcReferent` per station equation, in order along the alignment. */
  equationReferentIds: number[];
}

/**
 * Direction and curvature equality for the transition code use the
 * `numpy.allclose` defaults, as IfcOpenShell's
 * `get_curve_segment_transition_code` does. Position does NOT use its 1 mm:
 * authored LandXML joins reproduce only to a few millimetres (lengths and
 * radii are rounded independently of the coordinates), so 1 mm would mark
 * an ordinary join `.DISCONTINUOUS.` in mid-curve, which
 * `IfcCompositeCurve.CurveContinuous` forbids for an open curve (exactly one,
 * the last). Joins are compared at the mapping's own tolerance instead, and
 * a real gap beyond it is refused before anything is written (#5370 review).
 */
const POSITION_ATOL = ALIGNMENT_POSITION_TOLERANCE_M;
const allclose = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-8 + 1e-5 * Math.abs(b);

function transitionCode(segment: HorizontalSegment, next: HorizontalSegment): string {
  const samePosition = Math.hypot(segment.end[0] - next.start[0], segment.end[1] - next.start[1]) <= POSITION_ATOL;
  if (!samePosition) return '.DISCONTINUOUS.';
  const sameGradient = allclose(Math.cos(segment.endDirection), Math.cos(next.direction))
    && allclose(Math.sin(segment.endDirection), Math.sin(next.direction));
  if (!sameGradient) return '.CONTINUOUS.';
  return allclose(segment.endCurvature, next.startCurvature) ? '.CONTSAMEGRADIENTSAMECURVATURE.' : '.CONTSAMEGRADIENT.';
}

function point2d(ctx: AlignmentContext, [x, y]: readonly [number, number]): number {
  return ctx.emit('IFCCARTESIANPOINT', `(${num(x)},${num(y)})`);
}

function placement2d(ctx: AlignmentContext, at: readonly [number, number], direction: number): number {
  const location = point2d(ctx, at);
  const ref = ctx.emit('IFCDIRECTION', `(${num(Math.cos(direction))},${num(Math.sin(direction))})`);
  return ctx.emit('IFCAXIS2PLACEMENT2D', `#${location},#${ref}`);
}

/** A parent-curve `Position` at the origin along +X, as IfcOpenShell writes it. */
function originPlacement(ctx: AlignmentContext): number {
  return placement2d(ctx, [0, 0], 0);
}

function unitLine(ctx: AlignmentContext): number {
  const origin = point2d(ctx, [0, 0]);
  const dir = ctx.emit('IFCDIRECTION', '(1.,0.)');
  const vector = ctx.emit('IFCVECTOR', `#${dir},1.`);
  return ctx.emit('IFCLINE', `#${origin},#${vector}`);
}

/**
 * `IfcCurveSegment` for one horizontal segment — IfcOpenShell's mapping.
 *
 * - LINE: `IfcLine` at the origin; `SegmentLength = L`.
 * - CIRCULARARC: `IfcCircle` of radius `|R|`; `SegmentLength = L · sign(R)` —
 *   a negative length traverses the circle clockwise.
 * - CLOTHOID: `IfcClothoid` with `A = L / sqrt(|f|) · sign(f)`, where
 *   `f = L/R_end − L/R_start`, and a `SegmentStart` offset so a spiral that
 *   does not begin at infinite radius starts at the right point on the curve.
 */
function curveSegment(ctx: AlignmentContext, segment: HorizontalSegment, transition: string): number {
  const placement = placement2d(ctx, segment.start, segment.direction);
  const L = segment.length;
  let parent: number;
  let segmentStart = 0;
  let segmentLength = L;

  if (segment.type === 'LINE') {
    parent = unitLine(ctx);
  } else if (segment.type === 'CIRCULARARC') {
    parent = ctx.emit('IFCCIRCLE', `#${originPlacement(ctx)},${num(Math.abs(segment.startRadius))}`);
    segmentLength = L * Math.sign(segment.startRadius);
  } else {
    const r0 = segment.startRadius;
    const r1 = segment.endRadius;
    const f = (r1 === 0 ? 0 : L / r1) - (r0 === 0 ? 0 : L / r0);
    const A = (L / Math.sqrt(Math.abs(f))) * Math.sign(f);
    parent = ctx.emit('IFCCLOTHOID', `#${originPlacement(ctx)},${num(A)}`);
    if ((Math.abs(r0) < Math.abs(r1) && r0 !== 0) || r1 === 0) {
      segmentStart = -L - (r1 !== 0 ? (L * r0) / (r1 - r0) : 0);
    } else {
      segmentStart = r0 !== 0 ? (L * r1) / (r0 - r1) : 0;
    }
  }

  return ctx.emit(
    'IFCCURVESEGMENT',
    `${transition},#${placement},IFCLENGTHMEASURE(${num(segmentStart)}),IFCLENGTHMEASURE(${num(segmentLength)}),#${parent}`,
  );
}

function designParameters(ctx: AlignmentContext, segment: HorizontalSegment): number {
  return ctx.emit(
    'IFCALIGNMENTHORIZONTALSEGMENT',
    `$,$,#${point2d(ctx, segment.start)},${num(segment.direction)},${num(segment.startRadius)},`
    + `${num(segment.endRadius)},${num(segment.length)},$,.${segment.type}.`,
  );
}

/**
 * The zero-length `LINE` IFC 4.3 requires at the end of every layout, placed at
 * the alignment's end along its end tangent.
 */
function terminator(last: HorizontalSegment): HorizontalSegment {
  return {
    sourceId: `${last.sourceId}:end`,
    type: 'LINE',
    start: last.end,
    direction: last.endDirection,
    startRadius: 0,
    endRadius: 0,
    length: 0,
    end: last.end,
    endDirection: last.endDirection,
    startCurvature: 0,
    endCurvature: 0,
  };
}

export function emitAlignment(params: AlignmentParams, ctx: AlignmentContext): AlignmentResult {
  if (params.Segments.length === 0) {
    throw new Error('addAlignment: Segments is empty — an alignment needs at least one horizontal segment');
  }
  const guid = (role: string): string => params.guidFor?.(role) ?? ctx.newGlobalId();
  const layout = [...params.Segments, terminator(params.Segments[params.Segments.length - 1])];
  params.Segments.slice(1).forEach((next, index) => {
    const previous = params.Segments[index];
    const gap = Math.hypot(previous.end[0] - next.start[0], previous.end[1] - next.start[1]);
    if (gap > POSITION_ATOL) {
      throw new Error(
        `addAlignment: segment ${index + 2} starts ${gap.toFixed(3)} m from where segment ${index + 1} ends; `
        + 'an open IfcCompositeCurve may be discontinuous only at its last segment',
      );
    }
  });

  // Geometry: one curve segment per layout segment, the last DISCONTINUOUS —
  // `IfcCompositeCurve.CurveContinuous` requires exactly one for an open curve.
  const curveSegments = layout.map((segment, index) => curveSegment(
    ctx, segment, index === layout.length - 1 ? '.DISCONTINUOUS.' : transitionCode(segment, layout[index + 1]),
  ));
  const compositeCurveId = ctx.emit('IFCCOMPOSITECURVE', `(${curveSegments.map((id) => `#${id}`).join(',')}),.F.`);
  // With a vertical layout: the composite curve as 'FootPrint' first, the
  // gradient curve as 'Axis' — IfcOpenShell's horizontal + vertical case (§12.1).
  const gradientCurveId = params.Vertical ? emitGradientCurve(ctx, params.Vertical, compositeCurveId) : undefined;
  const representations = gradientCurveId === undefined
    ? [ctx.emit('IFCSHAPEREPRESENTATION', `${ctx.axisContextRef},'Axis','Curve2D',(#${compositeCurveId})`)]
    : [
      ctx.emit('IFCSHAPEREPRESENTATION', `${ctx.axisContextRef},'FootPrint','Curve2D',(#${compositeCurveId})`),
      ctx.emit('IFCSHAPEREPRESENTATION', `${ctx.axisContextRef},'Axis','Curve3D',(#${gradientCurveId})`),
    ];
  const shape = ctx.emit('IFCPRODUCTDEFINITIONSHAPE', `$,$,(${representations.map((id) => `#${id}`).join(',')})`);

  const alignmentId = ctx.emit(
    'IFCALIGNMENT',
    `'${params.GlobalId ?? guid('alignment')}',${ctx.ownerRef},'${esc(params.Name)}',$,$,${ctx.placementRef},#${shape},$`,
  );

  // Semantics: horizontal layout nested under the alignment, segments nested
  // in order under the layout.
  const horizontalId = ctx.emit('IFCALIGNMENTHORIZONTAL', `'${guid('horizontal')}',${ctx.ownerRef},$,$,$,$,$`);
  const vertical = params.Vertical ? emitVerticalLayout(ctx, params.Vertical, guid) : undefined;
  const layouts = vertical ? `#${horizontalId},#${vertical.verticalId}` : `#${horizontalId}`;
  ctx.emit('IFCRELNESTS', `'${guid('nests:layouts')}',${ctx.ownerRef},$,$,#${alignmentId},(${layouts})`);
  const segmentIds = layout.map((segment, index) => ctx.emit(
    'IFCALIGNMENTSEGMENT',
    `'${guid(`segment:${index}`)}',${ctx.ownerRef},$,$,$,$,$,#${designParameters(ctx, segment)}`,
  ));
  ctx.emit('IFCRELNESTS', `'${guid('nests:segments')}',${ctx.ownerRef},$,$,#${horizontalId},(${segmentIds.map((id) => `#${id}`).join(',')})`);

  // Stationing (§11.1, §14): the start referent, then one per station
  // equation, nested in order along the alignment.
  const [referentId, ...equationReferentIds] = emitStationing({
    alignmentId, compositeCurveId, segments: params.Segments, startStation: params.StartStation,
    equations: params.StationEquations ?? [],
  }, { emit: ctx.emit, ownerRef: ctx.ownerRef, guid });

  return {
    alignmentId, horizontalId, compositeCurveId, segmentIds, referentId, equationReferentIds,
    ...(vertical ? { verticalId: vertical.verticalId, gradientCurveId } : {}),
  };
}
