/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An alignment's stationing: `IfcReferent`s / `.STATION.` carrying
 * `Pset_Stationing`, nested under the alignment in order along it (mapping
 * spec §11.1, §14).
 *
 * Each referent is placed the way IfcOpenShell 0.8.5's
 * `add_stationing_referent` places one: an `IfcLinearPlacement` whose
 * `IfcPointByDistanceExpression` measures `DistanceAlong` on the alignment's
 * own composite curve, with the evaluated point and tangent as its
 * `CartesianPosition`.
 */

import { esc, num } from './ifc-creator-math.js';
import { evaluateSegment, type HorizontalSegment } from './landxml/alignment-mapping.js';

/** One station equation (§14.1): all lengths in the file's length unit. */
export interface StationEquationParams {
  /** Distance along the alignment's basis curve from its start. */
  DistanceAlong: number;
  /** `Pset_Stationing.Station` — the station from here on. */
  Station: number;
  /** `Pset_Stationing.IncomingStation` — the station arriving here. */
  IncomingStation: number;
  /** `Pset_Stationing.HasIncreasingStation`; omitted when `null` or absent. */
  HasIncreasingStation?: boolean | null;
  /** GlobalId seed role; defaults to `station-equation:<n>` (1-based). */
  Role?: string;
}

export interface StationingContext {
  emit: (type: string, attrs: string) => number;
  ownerRef: string;
  guid: (role: string) => string;
}

export interface StationingParams {
  alignmentId: number;
  compositeCurveId: number;
  segments: readonly HorizontalSegment[];
  startStation: number;
  equations: readonly StationEquationParams[];
}

/** `0+123.456` — kilometres and metres, the usual stationing label. */
export function stationLabel(station: number): string {
  const sign = station < 0 ? '-' : '';
  const abs = Math.abs(station);
  const km = Math.floor(abs / 1000);
  const m = (abs - km * 1000).toFixed(3).padStart(7, '0');
  return `${sign}${km}+${m}`;
}

/** Point and tangent direction at `distance` along the layout's segments. */
function pointAlong(segments: readonly HorizontalSegment[], distance: number): { point: [number, number]; direction: number } {
  let remaining = distance;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (remaining <= segment.length || index === segments.length - 1) {
      return evaluateSegment(
        segment.start, segment.direction, segment.startCurvature, segment.endCurvature, segment.length,
        Math.min(remaining, segment.length),
      );
    }
    remaining -= segment.length;
  }
  throw new Error('addAlignment: cannot place a referent on an alignment with no segments');
}

function linearPlacement(
  ctx: StationingContext, compositeCurveId: number, distance: number,
  at: { point: readonly [number, number]; direction: number },
): number {
  const along = ctx.emit('IFCPOINTBYDISTANCEEXPRESSION', `IFCLENGTHMEASURE(${num(distance)}),$,$,$,#${compositeCurveId}`);
  const linear = ctx.emit('IFCAXIS2PLACEMENTLINEAR', `#${along},$,$`);
  const point = ctx.emit('IFCCARTESIANPOINT', `(${num(at.point[0])},${num(at.point[1])},0.)`);
  const up = ctx.emit('IFCDIRECTION', '(0.,0.,1.)');
  const ahead = ctx.emit('IFCDIRECTION', `(${num(Math.cos(at.direction))},${num(Math.sin(at.direction))},0.)`);
  const cartesian = ctx.emit('IFCAXIS2PLACEMENT3D', `#${point},#${up},#${ahead}`);
  return ctx.emit('IFCLINEARPLACEMENT', `$,#${linear},#${cartesian}`);
}

function stationReferent(
  ctx: StationingContext, placement: number, station: number, roles: { referent: string; pset: string; rel: string },
  extra: string[] = [],
): number {
  const referentId = ctx.emit(
    'IFCREFERENT',
    `'${ctx.guid(roles.referent)}',${ctx.ownerRef},'${esc(stationLabel(station))}',$,$,#${placement},$,.STATION.`,
  );
  const properties = [
    ctx.emit('IFCPROPERTYSINGLEVALUE', `'Station',$,IFCLENGTHMEASURE(${num(station)}),$`),
    ...extra.map((attrs) => ctx.emit('IFCPROPERTYSINGLEVALUE', attrs)),
  ];
  const pset = ctx.emit(
    'IFCPROPERTYSET',
    `'${ctx.guid(roles.pset)}',${ctx.ownerRef},'Pset_Stationing',$,(${properties.map((id) => `#${id}`).join(',')})`,
  );
  ctx.emit('IFCRELDEFINESBYPROPERTIES', `'${ctx.guid(roles.rel)}',${ctx.ownerRef},$,$,(#${referentId}),#${pset}`);
  return referentId;
}

/**
 * Write the start referent (distance 0) and one referent per station
 * equation, nest them under the alignment in order along it, and position
 * the alignment by the start referent. Returns the referent ids, start first.
 */
export function emitStationing(params: StationingParams, ctx: StationingContext): number[] {
  const first = params.segments[0];
  const startPlacement = linearPlacement(ctx, params.compositeCurveId, 0, { point: first.start, direction: first.direction });
  const startId = stationReferent(ctx, startPlacement, params.startStation, {
    referent: 'referent:start', pset: 'pset:stationing', rel: 'rel:stationing',
  });

  let previous = 0;
  const equationIds = params.equations.map((equation, index) => {
    if (!(equation.DistanceAlong > previous)) {
      throw new Error(
        `addAlignment: station equation ${index + 1} is at ${equation.DistanceAlong} along the alignment, `
        + 'not after the previous referent; referents are nested in order along it',
      );
    }
    previous = equation.DistanceAlong;
    const role = equation.Role ?? `station-equation:${index + 1}`;
    const placement = linearPlacement(
      ctx, params.compositeCurveId, equation.DistanceAlong, pointAlong(params.segments, equation.DistanceAlong),
    );
    const extra = [`'IncomingStation',$,IFCLENGTHMEASURE(${num(equation.IncomingStation)}),$`];
    if (equation.HasIncreasingStation !== null && equation.HasIncreasingStation !== undefined) {
      extra.push(`'HasIncreasingStation',$,IFCBOOLEAN(${equation.HasIncreasingStation ? '.T.' : '.F.'}),$`);
    }
    return stationReferent(ctx, placement, equation.Station, {
      referent: role, pset: `${role}:pset`, rel: `${role}:rel`,
    }, extra);
  });

  const referents = [startId, ...equationIds];
  ctx.emit(
    'IFCRELNESTS',
    `'${ctx.guid('nests:referents')}',${ctx.ownerRef},$,$,#${params.alignmentId},(${referents.map((id) => `#${id}`).join(',')})`,
  );
  ctx.emit('IFCRELPOSITIONS', `'${ctx.guid('positions')}',${ctx.ownerRef},$,$,#${startId},(#${params.alignmentId})`);
  return referents;
}
