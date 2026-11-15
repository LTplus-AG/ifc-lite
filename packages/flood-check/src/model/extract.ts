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
import { prepareFootprint, signedDistance } from '../region.js';
import type { MapPoint } from '../types.js';
import { selectCandidates } from './candidates.js';
import { NO_PLACEMENT } from './candidate-base.js';
import { FloodCheckRefusal } from '../errors.js';
import { buildingLabel, footprintConcerns, type BuildingRef, type BuildingScope, type ModelFacts, type SpaceFact, type StoreyFact } from './facts.js';
import { resolveFootprint } from './footprint.js';
import { georeferenceData, resolveModelGeoreference, type GeoreferenceOptions, type ModelGeoreference } from './georef.js';
import { axisPlacementFrame, PlacementResolver } from './placement.js';
import { asString, ModelReader } from './reader.js';

export interface ExtractOptions extends GeoreferenceOptions {
  /** The ground storey, by express id, GlobalId or Name. Default: the storey at project ±0.00 (see README). */
  groundStorey?: number | string;
  /**
   * Footprint rings in map coordinates (for example a cadastral or survey
   * outline); replaces the model-derived one. Prefer it when the model has no
   * ground-floor slab outline: a hull fills courtyards and notches. A ring
   * lying wholly inside the others and enclosing 1 m² or more is a courtyard
   * (a hole, open ground); a smaller nested ring stays closed.
   */
  footprint?: MapPoint[][];
  /** Doors, windows and openings higher than this above the ground storey are not listed. Default 3.0 m; may only be raised. */
  aboveGroundScope?: number;
  /**
   * Distance from the outline within which an element without `IsExternal`
   * counts as façade. Default 1.0 m; may only be raised (a smaller value
   * would leave façade elements unlisted, which reads as nothing found).
   */
  boundaryTolerance?: number;
}

const MAX_SPATIAL_HOPS = 16;

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

/**
 * The building whose elements are checked: the ground storey's. The footprint
 * is that building's outline, so an element of another building would be
 * sampled next to itself, possibly inside its own building, where the hazard
 * map shows no depth (it raised every building), and would read as "no runoff
 * mapped". Elements of other buildings are therefore not checked, and the
 * result names those buildings with a count; never silently.
 */
function scopeToBuilding(
  reader: ModelReader,
  groundStorey: number | null,
  storeyCount: number,
): { checked: BuildingRef | null; others: BuildingRef[]; buildingOf(id: number): number | null; inScope(building: number | null): boolean } {
  const ids = reader.idsOfType('IFCBUILDING');
  const ref = (id: number): BuildingRef => {
    const e = reader.entity(id);
    return { expressId: id, globalId: asString(reader.attr(e, 'GlobalId')), name: asString(reader.attr(e, 'Name')) };
  };
  const buildingOf = storeyResolver(reader, new Set(ids));
  if (ids.length <= 1) {
    return { checked: ids.length === 1 ? ref(ids[0]) : null, others: [], buildingOf, inScope: () => true };
  }
  const checked = groundStorey === null ? null : buildingOf(groundStorey);
  if (checked === null) {
    throw new FloodCheckRefusal(
      'ambiguous-building',
      `the file contains ${ids.length} IfcBuilding entities and ${storeyCount === 0 ? 'no IfcBuildingStorey' : 'the ground storey is not placed in any of them'}, ` +
        'so it is unknown which building the footprint belongs to; pass groundStorey (a storey of the building to check)',
    );
  }
  // A building containing the checked one (a building complex) holds elements that are not in any storey of it.
  const enclosing = new Set<number>([checked]);
  for (let b: number | null = buildingOf(checked); b !== null && !enclosing.has(b); b = buildingOf(b)) enclosing.add(b);
  return {
    checked: ref(checked),
    others: ids.filter((id) => !enclosing.has(id)).map(ref),
    buildingOf,
    // An element in no building (for example contained in the site) is kept, as in a single-building file.
    inScope: (building) => building === null || enclosing.has(building),
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
    const matches = storeys.filter((st) => matchesStorey(reader, st.expressId, wanted));
    if (matches.length === 0) throw new RangeError(`no IfcBuildingStorey matches groundStorey ${JSON.stringify(wanted)}`);
    // A name shared by several storeys (two buildings each with an "EG") would pick a building by entity order: refused.
    if (matches.length > 1) {
      const list = matches.map((st) => `#${st.expressId} "${st.name ?? ''}" (GlobalId ${st.globalId ?? 'none'})`).join(', ');
      throw new FloodCheckRefusal(
        'ambiguous-building',
        `groundStorey ${JSON.stringify(wanted)} matches ${matches.length} storeys: ${list}; pass the storey's GlobalId or express id to choose one`,
      );
    }
    const s = matches[0];
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
    warnings.push(
      `the ground storey "${best.name ?? best.expressId}" is only picked by the ±0.00 convention (it may be a basement), so the height reference stays unconfirmed — pass groundStorey to state it`,
    );
    return { expressId: best.expressId, level: best.level, basis: 'project-zero' };
  }
  const lowest = storeys.reduce((a, b) => (b.level < a.level ? b : a));
  warnings.push(
    `no storey sits at project ±0.00; the lowest storey "${lowest.name ?? lowest.expressId}" is taken as ground storey — pass groundStorey to override`,
  );
  return { expressId: lowest.expressId, level: lowest.level, basis: 'lowest-storey' };
}

/** Options that only widen what is listed: a smaller value would leave elements out without saying so. */
function atLeast(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!(value >= fallback) || !Number.isFinite(value)) {
    throw new RangeError(`${name} may only be raised (default ${fallback} m), got ${value}: a smaller value would leave elements unlisted`);
  }
  return value;
}

/**
 * Placements are read relative to the world origin; a representation context
 * whose `WorldCoordinateSystem` moves or turns that origin would shift every
 * position and level, so it is refused rather than ignored.
 */
/** Identity tolerances: a micrometre for the origin (after unit scaling), 1e-6 for each direction component. */
export const WCS_ORIGIN_TOLERANCE_M = 1e-6;
export const WCS_DIRECTION_TOLERANCE = 1e-6;

function refuseShiftedWorldCoordinateSystem(reader: ModelReader, lengthUnitScale: number): void {
  for (const id of reader.idsOfType('IFCGEOMETRICREPRESENTATIONCONTEXT')) {
    const wcs = reader.attr(reader.entity(id), 'WorldCoordinateSystem');
    if (wcs === null || wcs === undefined) continue;
    const f = axisPlacementFrame(reader, wcs);
    const near = (a: readonly number[], b: readonly number[], tol: number, k = 1) => a.every((v, i) => Math.abs(v * k - b[i]) <= tol);
    const dir = (a: readonly number[], b: readonly number[]) => near(a, b, WCS_DIRECTION_TOLERANCE);
    if (!f || !near(f.origin, [0, 0, 0], WCS_ORIGIN_TOLERANCE_M, lengthUnitScale) || !dir(f.x, [1, 0, 0]) || !dir(f.y, [0, 1, 0]) || !dir(f.z, [0, 0, 1])) {
      throw new FloodCheckRefusal(
        'world-coordinate-system',
        `representation context #${id} has a WorldCoordinateSystem that is not the identity (or cannot be read); positions and levels would shift, so the model is not checked`,
      );
    }
  }
}

/** Read the model facts the flood check needs. Throws {@link FloodCheckRefusal} when georeferencing does not allow it. */
export function extractModelFacts(store: IfcDataStore, options: ExtractOptions = {}): ModelFacts {
  const georef = resolveModelGeoreference(store, options);
  const reader = new ModelReader(store);
  refuseShiftedWorldCoordinateSystem(reader, georef.lengthUnitScale);
  const nameOf = (id: number) => {
    const name = asString(reader.attr(reader.entity(id), 'Name'));
    return name ? ` "${name}"` : '';
  };
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
      skipped.push({ expressId: id, ifcClass: 'IfcBuildingStorey', reason: NO_PLACEMENT, stage: 'storey' });
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

  // The footprint and its accumulated quality (`footprint.ts`): one record, never upgraded by a fallback.
  const resolution = resolveFootprint({ reader, placements, georef, storeyOf, ground: groundStorey, given: options.footprint, skipped, warnings });
  const derived = resolution.fact;
  // One prepared footprint for every selection rule and the outside check below.
  const region = prepareFootprint(derived ?? { rings: [], source: 'candidate-hull' });

  const buildings = scopeToBuilding(reader, groundStorey.expressId, storeys.length);
  const notChecked = new Map(buildings.others.map((b) => [b.expressId, { ...b, candidatesNotChecked: 0 }]));
  const selection = selectCandidates(
    {
      reader,
      placements,
      georef,
      storeyOf,
      storeyLevel: new Map(storeys.map((s) => [s.expressId, s.level])),
      groundLevel: groundStorey.level,
      footprint: region,
      footprintQuality: derived ? footprintConcerns(derived) : null,
      // Only a stated ground storey is known: the ±0.00 convention can pick the basement (re-audit N2).
      groundUncertain: groundStorey.basis !== 'given',
      aboveGroundScope: atLeast('aboveGroundScope', options.aboveGroundScope, 3),
      boundaryTolerance: atLeast('boundaryTolerance', options.boundaryTolerance, 1),
    },
    (id) => {
      const building = buildings.buildingOf(id);
      if (buildings.inScope(building)) return null;
      const other = building === null ? undefined : notChecked.get(building);
      if (!other) return null;
      other.candidatesNotChecked++;
      return buildingLabel(other);
    },
  );
  // Every covered element walked is a candidate or skipped: a third way out would fail here, not go missing.
  if (selection.walked !== selection.candidates.length + selection.skipped.length) {
    throw new Error(`candidate selection walked ${selection.walked} elements but listed ${selection.candidates.length} candidates and ${selection.skipped.length} skipped`);
  }
  const candidates = selection.candidates;
  skipped.push(...selection.skipped);
  const buildingScope: BuildingScope = { checked: buildings.checked, notChecked: [...notChecked.values()] };
  const unplaced = skipped.filter((e) => e.reason === NO_PLACEMENT && e.ifcClass !== 'IfcBuildingStorey');
  if (unplaced.length > 0) {
    warnings.push(
      `${unplaced.length} element(s) of the checked classes could not be placed and have no result: ` +
        unplaced.map((e) => `${e.ifcClass} #${e.expressId}${nameOf(e.expressId)}`).join(', '),
    );
  }
  if (buildingScope.notChecked.length > 0) {
    const n = buildingScope.notChecked.reduce((sum, b) => sum + b.candidatesNotChecked, 0);
    warnings.push(
      `the file contains ${buildingScope.notChecked.length + 1} buildings; only ${buildingScope.checked ? buildingLabel(buildingScope.checked) : 'the ground storey\'s'} ` +
        `(the ground storey's) was checked. Not checked: ${buildingScope.notChecked.map((b) => `${buildingLabel(b)} (${b.candidatesNotChecked} candidate element(s))`).join(', ')}; ` +
        `those ${n} element(s) have no result. ` +
        'Run the check again with groundStorey set to a storey of each other building',
    );
  }

  // A façade element of the checked building standing more than the tolerance outside the footprint shows the footprint
  // misses part of the building: it is marked partial (the element itself was kept, `facadeReason`).
  const tolerance = atLeast('boundaryTolerance', options.boundaryTolerance, 1);
  const outside = derived
    ? candidates
        .filter((c) => ['door', 'window', 'basement-window', 'wall-opening'].includes(c.category))
        .map((c) => ({ expressId: c.expressId, ifcClass: c.ifcClass, distance: signedDistance(region, c.position) ?? 0 }))
        .filter((o) => o.distance > tolerance)
    : [];
  const footprint = resolution.finish(candidates.map((c) => c.position), outside);


  const spaces: SpaceFact[] = [];
  for (const id of reader.idsOfType('IFCSPACE')) {
    const e = reader.entity(id);
    const frame = placements.ofProduct(id);
    if (!e || !frame || !buildings.inScope(buildings.buildingOf(id))) continue;
    spaces.push({
      expressId: id,
      globalId: asString(reader.attr(e, 'GlobalId')),
      name: asString(reader.attr(e, 'LongName')) ?? asString(reader.attr(e, 'Name')),
      storeyId: storeyOf(id),
      floorLevel: georef.toMap(frame.origin)[2],
    });
  }

  return { georeference: georeferenceData(georef), footprint, storeys, groundStorey, candidates, spaces, buildingScope, coverage: { walked: selection.walked, skipped: selection.skipped.length }, skipped, warnings };
}
