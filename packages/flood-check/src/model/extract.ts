/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model facts from a parsed STEP store, with no meshing: placements, a few
 * representation entities (slab outlines, wall axes), properties and spatial
 * containment. Cost is one placement-chain walk per element plus on-demand
 * property reads for doors, windows, walls, stairs and ramps; for a 7 MB
 * model it runs in well under a second after parsing.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';
import { chainIntoRing, convexHull, ringArea } from '../geom.js';
import type { MapPoint } from '../types.js';
import { collectCandidates, isExternal } from './candidates.js';
import type { FootprintFact, ModelFacts, SpaceFact, StoreyFact } from './facts.js';
import { georeferenceData, resolveModelGeoreference, type GeoreferenceOptions, type ModelGeoreference } from './georef.js';
import { slabOutline, toWorld, wallAxis } from './outline.js';
import { PlacementResolver } from './placement.js';
import { asEnum, asString, ModelReader } from './reader.js';

export interface ExtractOptions extends GeoreferenceOptions {
  /** The ground storey, by express id, GlobalId or Name. Default: the storey at project ±0.00 (see README). */
  groundStorey?: number | string;
  /**
   * Footprint rings in map coordinates (for example a cadastral or survey
   * outline); replaces the model-derived one. Prefer it when the model has no
   * ground-floor slab outline: a hull fills courtyards and notches.
   */
  footprint?: MapPoint[][];
  /** Doors, windows and openings higher than this above the ground storey are not listed. Default 3.0 m. */
  aboveGroundScope?: number;
  /**
   * Distance from the outline within which an element without `IsExternal`
   * counts as façade. Default 1.0 m. Pass the same value as the check's
   * `anchorTolerance`.
   */
  boundaryTolerance?: number;
}

const MAX_SPATIAL_HOPS = 16;
/** Wall axes meeting at a butt joint stop about half a wall thickness short of each other. */
const WALL_JOIN_TOLERANCE = 0.5;

function storeyResolver(reader: ModelReader, storeys: ReadonlySet<number>): (id: number) => number | null {
  const memo = new Map<number, number | null>();
  return (id: number) => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    let current: number | undefined = id;
    let found: number | null = null;
    const seen = new Set<number>();
    for (let hop = 0; current !== undefined && hop < MAX_SPATIAL_HOPS && !seen.has(current); hop++) {
      seen.add(current);
      if (current !== id && storeys.has(current)) {
        found = current;
        break;
      }
      current =
        reader.related(current, RelationshipType.ContainsElements, 'inverse')[0] ??
        reader.related(current, RelationshipType.Aggregates, 'inverse')[0] ??
        reader.related(current, RelationshipType.VoidsElement, 'inverse')[0] ??
        reader.related(current, RelationshipType.FillsElement, 'inverse')[0];
    }
    memo.set(id, found);
    return found;
  };
}

function matchesStorey(reader: ModelReader, id: number, wanted: number | string): boolean {
  if (typeof wanted === 'number') return id === wanted;
  const e = reader.entity(id);
  return asString(reader.attr(e, 'GlobalId')) === wanted || asString(reader.attr(e, 'Name')) === wanted;
}

function pickGroundStorey(
  storeys: StoreyFact[],
  localLevels: ReadonlyMap<number, number>,
  reader: ModelReader,
  georef: ModelGeoreference,
  wanted: number | string | undefined,
  warnings: string[],
): ModelFacts['groundStorey'] {
  if (wanted !== undefined) {
    const s = storeys.find((st) => matchesStorey(reader, st.expressId, wanted));
    if (!s) throw new RangeError(`no IfcBuildingStorey matches groundStorey ${JSON.stringify(wanted)}`);
    return { expressId: s.expressId, level: s.level, basis: 'given' };
  }
  if (storeys.length === 0) {
    warnings.push('the model has no IfcBuildingStorey; the ground level is taken as the map conversion origin height');
    return { expressId: null, level: georef.orthogonalHeight, basis: 'none' };
  }
  // Convention: project ±0.00 is the ground floor, so the storey placed nearest local z = 0 (not below -0.3 m).
  let best: StoreyFact | null = null;
  for (const s of storeys) {
    const z = localLevels.get(s.expressId) ?? NaN;
    if (!(z >= -0.3)) continue;
    if (!best || Math.abs(z) < Math.abs(localLevels.get(best.expressId) ?? Infinity)) best = s;
  }
  if (best && Math.abs(localLevels.get(best.expressId) ?? Infinity) <= 1.5) {
    return { expressId: best.expressId, level: best.level, basis: 'project-zero' };
  }
  const lowest = storeys.reduce((a, b) => (b.level < a.level ? b : a));
  warnings.push(
    `no storey sits at project ±0.00; the lowest storey "${lowest.name ?? lowest.expressId}" is taken as ground storey — pass groundStorey to override`,
  );
  return { expressId: lowest.expressId, level: lowest.level, basis: 'lowest-storey' };
}

function deriveFootprint(
  reader: ModelReader,
  placements: PlacementResolver,
  georef: ModelGeoreference,
  storeyOf: (id: number) => number | null,
  ground: ModelFacts['groundStorey'],
): FootprintFact | null {
  const toRing = (pts: [number, number, number][]): MapPoint[] => pts.map((p) => {
    const [x, y] = georef.toMap(p);
    return { x, y };
  });
  const rings: MapPoint[][] = [];
  const from: number[] = [];
  for (const id of reader.idsOfType('IFCSLAB')) {
    if (ground.expressId !== null && storeyOf(id) !== ground.expressId) continue;
    const kind = asEnum(reader.attr(reader.entity(id), 'PredefinedType'));
    if (kind && !['FLOOR', 'BASESLAB', 'NOTDEFINED', 'USERDEFINED'].includes(kind)) continue;
    const frame = placements.ofProduct(id);
    const outline = frame ? slabOutline(reader, id) : null;
    if (!frame || !outline) continue;
    const ring = toRing(toWorld(frame, outline));
    if (ringArea(ring) < 1) continue;
    rings.push(ring);
    from.push(id);
  }
  if (rings.length > 0) return { rings, source: 'slab-outline', fromElements: from };

  const points: MapPoint[] = [];
  const axes: MapPoint[][] = [];
  let everyAxisRead = true;
  for (const type of ['IFCWALL', 'IFCWALLSTANDARDCASE']) {
    for (const id of reader.idsOfType(type)) {
      const wall = reader.entity(id);
      if (!wall || isExternal(reader, wall) !== true) continue;
      if (ground.expressId !== null && storeyOf(id) !== ground.expressId) continue;
      const frame = placements.ofProduct(id);
      if (!frame) continue;
      const axis = wallAxis(reader, id);
      if (!axis || axis.length < 2) everyAxisRead = false;
      const line = toRing(toWorld(frame, axis ?? [[0, 0, 0]]));
      points.push(...line);
      axes.push(line);
      from.push(id);
    }
  }
  // A real outline first: the external walls' axes chained into one closed ring keeps courtyards and notches.
  const chained = everyAxisRead ? chainIntoRing(axes, WALL_JOIN_TOLERANCE) : null;
  if (chained && ringArea(chained) >= 1) return { rings: [chained], source: 'external-wall-outline', fromElements: from };
  const hull = convexHull(points);
  if (hull.length >= 3 && ringArea(hull) >= 1) return { rings: [hull], source: 'external-wall-hull', fromElements: from };
  return null;
}

/** Read the model facts the flood check needs. Throws {@link FloodCheckRefusal} when georeferencing does not allow it. */
export function extractModelFacts(store: IfcDataStore, options: ExtractOptions = {}): ModelFacts {
  const georef = resolveModelGeoreference(store, options);
  const reader = new ModelReader(store);
  const placements = new PlacementResolver(reader);
  const warnings: string[] = [];
  const skipped: ModelFacts['skipped'] = [];

  const storeyIds = reader.idsOfType('IFCBUILDINGSTOREY');
  const storeys: StoreyFact[] = [];
  const localLevels = new Map<number, number>();
  for (const id of storeyIds) {
    const e = reader.entity(id);
    const frame = placements.ofProduct(id);
    if (!e || !frame) {
      skipped.push({ expressId: id, ifcClass: 'IfcBuildingStorey', reason: 'no readable IfcLocalPlacement chain' });
      continue;
    }
    localLevels.set(id, frame.origin[2] * georef.lengthUnitScale);
    storeys.push({
      expressId: id,
      globalId: asString(reader.attr(e, 'GlobalId')),
      name: asString(reader.attr(e, 'Name')),
      level: georef.toMap(frame.origin)[2],
    });
  }
  storeys.sort((a, b) => a.level - b.level);
  const storeyOf = storeyResolver(reader, new Set(storeys.map((s) => s.expressId)));
  const groundStorey = pickGroundStorey(storeys, localLevels, reader, georef, options.groundStorey, warnings);

  let footprint: FootprintFact | null = options.footprint
    ? { rings: options.footprint, source: 'given', fromElements: [] }
    : deriveFootprint(reader, placements, georef, storeyOf, groundStorey);

  const candidates = collectCandidates({
    reader,
    placements,
    georef,
    storeyOf,
    storeyLevel: new Map(storeys.map((s) => [s.expressId, s.level])),
    groundLevel: groundStorey.level,
    footprint: footprint?.rings ?? [],
    aboveGroundScope: options.aboveGroundScope ?? 3,
    boundaryTolerance: options.boundaryTolerance ?? 1,
    skip: (expressId, ifcClass, reason) => skipped.push({ expressId, ifcClass, reason }),
  });

  if (!footprint) {
    const hull = convexHull(candidates.map((c) => c.position));
    footprint = { rings: hull.length >= 3 ? [hull] : [], source: 'candidate-hull', fromElements: [] };
    warnings.push(
      'no slab outline or external wall could be read in the ground storey; the footprint is the hull of the candidates and ' +
        'ground samples near interior elements may fall inside the real building',
    );
  }

  const spaces: SpaceFact[] = [];
  for (const id of reader.idsOfType('IFCSPACE')) {
    const e = reader.entity(id);
    const frame = placements.ofProduct(id);
    if (!e || !frame) continue;
    spaces.push({
      expressId: id,
      globalId: asString(reader.attr(e, 'GlobalId')),
      name: asString(reader.attr(e, 'LongName')) ?? asString(reader.attr(e, 'Name')),
      storeyId: storeyOf(id),
      floorLevel: georef.toMap(frame.origin)[2],
    });
  }

  return { georeference: georeferenceData(georef), footprint, storeys, groundStorey, candidates, spaces, skipped, warnings };
}
