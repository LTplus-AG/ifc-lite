/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcAlignment` emitter — horizontal layout only (mapping spec §11).
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
import type { HorizontalSegment } from './landxml/alignment-mapping.js';

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
}

/**
 * Curvature/position equality for the transition code, with the tolerances
 * IfcOpenShell's `get_curve_segment_transition_code` uses: 1 mm on position,
 * `numpy.allclose` defaults on direction and curvature.
 */
const POSITION_ATOL = 0.001;
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

/** `0+123.456` — kilometres and metres, the usual stationing label. */
function stationLabel(station: number): string {
  const sign = station < 0 ? '-' : '';
  const abs = Math.abs(station);
  const km = Math.floor(abs / 1000);
  const m = (abs - km * 1000).toFixed(3).padStart(7, '0');
  return `${sign}${km}+${m}`;
}

export function emitAlignment(params: AlignmentParams, ctx: AlignmentContext): AlignmentResult {
  if (params.Segments.length === 0) {
    throw new Error('addAlignment: Segments is empty — an alignment needs at least one horizontal segment');
  }
  const guid = (role: string): string => params.guidFor?.(role) ?? ctx.newGlobalId();
  const layout = [...params.Segments, terminator(params.Segments[params.Segments.length - 1])];

  // Geometry: one curve segment per layout segment, the last DISCONTINUOUS —
  // `IfcCompositeCurve.CurveContinuous` requires exactly one for an open curve.
  const curveSegments = layout.map((segment, index) => curveSegment(
    ctx, segment, index === layout.length - 1 ? '.DISCONTINUOUS.' : transitionCode(segment, layout[index + 1]),
  ));
  const compositeCurveId = ctx.emit('IFCCOMPOSITECURVE', `(${curveSegments.map((id) => `#${id}`).join(',')}),.F.`);
  const representation = ctx.emit('IFCSHAPEREPRESENTATION', `${ctx.axisContextRef},'Axis','Curve2D',(#${compositeCurveId})`);
  const shape = ctx.emit('IFCPRODUCTDEFINITIONSHAPE', `$,$,(#${representation})`);

  const alignmentId = ctx.emit(
    'IFCALIGNMENT',
    `'${params.GlobalId ?? guid('alignment')}',${ctx.ownerRef},'${esc(params.Name)}',$,$,${ctx.placementRef},#${shape},$`,
  );

  // Semantics: horizontal layout nested under the alignment, segments nested
  // in order under the layout.
  const horizontalId = ctx.emit('IFCALIGNMENTHORIZONTAL', `'${guid('horizontal')}',${ctx.ownerRef},$,$,$,$,$`);
  ctx.emit('IFCRELNESTS', `'${guid('nests:layouts')}',${ctx.ownerRef},$,$,#${alignmentId},(#${horizontalId})`);
  const segmentIds = layout.map((segment, index) => ctx.emit(
    'IFCALIGNMENTSEGMENT',
    `'${guid(`segment:${index}`)}',${ctx.ownerRef},$,$,$,$,$,#${designParameters(ctx, segment)}`,
  ));
  ctx.emit('IFCRELNESTS', `'${guid('nests:segments')}',${ctx.ownerRef},$,$,#${horizontalId},(${segmentIds.map((id) => `#${id}`).join(',')})`);

  // Stationing: an IfcReferent at distance 0 along the alignment's own curve.
  const first = params.Segments[0];
  const along = ctx.emit('IFCPOINTBYDISTANCEEXPRESSION', `IFCLENGTHMEASURE(0.),$,$,$,#${compositeCurveId}`);
  const linear = ctx.emit('IFCAXIS2PLACEMENTLINEAR', `#${along},$,$`);
  const at = ctx.emit('IFCCARTESIANPOINT', `(${num(first.start[0])},${num(first.start[1])},0.)`);
  const up = ctx.emit('IFCDIRECTION', '(0.,0.,1.)');
  const ahead = ctx.emit('IFCDIRECTION', `(${num(Math.cos(first.direction))},${num(Math.sin(first.direction))},0.)`);
  const cartesian = ctx.emit('IFCAXIS2PLACEMENT3D', `#${at},#${up},#${ahead}`);
  const placement = ctx.emit('IFCLINEARPLACEMENT', `$,#${linear},#${cartesian}`);
  const referentId = ctx.emit(
    'IFCREFERENT',
    `'${guid('referent:start')}',${ctx.ownerRef},'${stationLabel(params.StartStation)}',$,$,#${placement},$,.STATION.`,
  );
  const station = ctx.emit('IFCPROPERTYSINGLEVALUE', `'Station',$,IFCLENGTHMEASURE(${num(params.StartStation)}),$`);
  const pset = ctx.emit('IFCPROPERTYSET', `'${guid('pset:stationing')}',${ctx.ownerRef},'Pset_Stationing',$,(#${station})`);
  ctx.emit('IFCRELDEFINESBYPROPERTIES', `'${guid('rel:stationing')}',${ctx.ownerRef},$,$,(#${referentId}),#${pset}`);
  ctx.emit('IFCRELNESTS', `'${guid('nests:referents')}',${ctx.ownerRef},$,$,#${alignmentId},(#${referentId})`);
  ctx.emit('IFCRELPOSITIONS', `'${guid('positions')}',${ctx.ownerRef},$,$,#${referentId},(#${alignmentId})`);

  return { alignmentId, horizontalId, compositeCurveId, segmentIds, referentId };
}
