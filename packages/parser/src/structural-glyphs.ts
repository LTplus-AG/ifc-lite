/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Supports and loads of a structural analysis model as a plain-data glyph
 * list (#9668): position, direction, kind, magnitude and the source entity.
 * No renderer types: the viewer draws the list, tests and the coverage probe
 * check it.
 *
 * Positions and directions are IFC world coordinates in metres, Z up, of the
 * one model the store holds; a consumer applies its own render frame, as it
 * does for every other model-space overlay.
 *
 * What is drawn:
 * - a support at every point, curve and surface connection whose
 *   `AppliedCondition` restrains something (`structuralSupportKind`); along an
 *   edge or over a face it repeats. Its `direction` is the support frame's Z
 *   (the connection's `ConditionCoordinateSystem` when given): the symbol hangs
 *   below the node, against it.
 * - for each action (reactions are results, not drawn): the force resultant of
 *   X/Y/Z as an arrow per station, the moment resultant as one moment glyph,
 *   and a marker for a displacement or a temperature load. `LOCAL_COORDS` loads
 *   are turned into world axes by the activity's frame: its own placement, the
 *   point connection's condition frame, or the member's (x along the edge,
 *   z towards `Axis`). Load configurations draw each value at its location.
 *
 * `relative` scales arrows within their load group: the largest force (or
 * moment) of the same distribution in the same group is 1. Units differ by
 * distribution (N, N/m, N/m2), so each scales on its own.
 *
 * Activities on a varying linear or planar action draw their first value
 * along the whole shape (the varying stations are not read yet).
 */

import type { IfcDataStore } from './columnar-parser.js';
import type { StructuralActivityInfo, StructuralExtraction } from './structural-types.js';
import type { StructuralLoadInfo } from './structural-load-extractor.js';
import { structuralSupportKind, type StructuralSupportKind } from './structural-support-kind.js';
import { compose, IDENTITY, ItemGeometryReader, length, normalize, rotate, type Frame, type ItemShape, type Vec3 } from './structural-item-geometry.js';
import { pointAlong, shapeCentre, shapeFrame, shapeStations } from './structural-glyph-stations.js';

export type { StructuralSupportKind } from './structural-support-kind.js';
export type { Vec3 as StructuralGlyphVec3 } from './structural-item-geometry.js';

/** The connection or activity a glyph stands for: what a click selects. */
export interface StructuralGlyphSource {
  expressId: number;
  globalId: string;
  /** Canonical EXPRESS name, e.g. `IfcStructuralPointConnection`. */
  type: string;
}

export type StructuralLoadDistribution = 'point' | 'linear' | 'planar';

interface GlyphBase {
  /** IFC world, metres, Z up. */
  position: Vec3;
  source: StructuralGlyphSource;
}

export type StructuralGlyph =
  /** `direction`: the support frame's Z, unit. */
  | (GlyphBase & { kind: 'support'; support: StructuralSupportKind; direction: Vec3 })
  /** `direction`: the force (or moment axis, right hand), unit. `magnitude` in the file's units; `relative` in (0, 1]. */
  | (GlyphBase & { kind: 'force' | 'moment'; distribution: StructuralLoadDistribution; direction: Vec3; magnitude: number; relative: number })
  /** `direction`: the translation, when the displacement has one. */
  | (GlyphBase & { kind: 'displacement'; direction?: Vec3 })
  | (GlyphBase & { kind: 'temperature' });

export interface StructuralGlyphSet {
  glyphs: StructuralGlyph[];
  /**
   * Supported connections and actions with a load that could not be placed:
   * no topology representation of the expected kind on the entity or the item
   * it acts on, or a placement this reader does not follow. Never drawn at a
   * guessed position.
   */
  unplaced: StructuralGlyphSource[];
}

const DISTRIBUTION: Record<ItemShape['kind'], StructuralLoadDistribution> = { vertex: 'point', edge: 'linear', face: 'planar' };

/** The shape an entity type acts on: point, curve (linear) or surface (planar). */
function expectedShape(type: string): ItemShape['kind'] | null {
  if (/Point/.test(type)) return 'vertex';
  if (/Linear|Curve/.test(type)) return 'edge';
  if (/Planar|Surface/.test(type)) return 'face';
  return null;
}

/** The X/Y/Z vector of `prefix` components (`Force`, `LinearForce`, ...), null when none is non-zero. */
function vector(load: StructuralLoadInfo, prefixes: readonly string[]): Vec3 | null {
  for (const prefix of prefixes) {
    const c = load.components;
    const v: Vec3 = [c[`${prefix}X`] ?? 0, c[`${prefix}Y`] ?? 0, c[`${prefix}Z`] ?? 0];
    if (length(v) > 0) return v;
  }
  return null;
}

const FORCE = ['Force', 'LinearForce', 'PlanarForce'];
const MOMENT = ['Moment', 'LinearMoment'];

const isTemperature = (load: StructuralLoadInfo) => /Temperature/.test(load.type) && Object.values(load.components).some((v) => v !== 0);

/**
 * Whether a load has anything to draw. A bare `IfcStructuralLoad` (Axis
 * writes one per self-weight action) or an all-zero load has not, and is
 * neither drawn nor counted as unplaced.
 */
function drawable(load: StructuralLoadInfo): boolean {
  if (load.configuration) return load.configuration.entries.some((e) => !!e.value && drawable(e.value));
  return !!(vector(load, FORCE) || vector(load, MOMENT) || vector(load, ['Displacement']) || vector(load, ['RotationalDisplacementR']) || isTemperature(load));
}

const sourceOf = (e: { expressId: number; globalId: string; type: string }): StructuralGlyphSource =>
  ({ expressId: e.expressId, globalId: e.globalId, type: e.type });

type Pending = Extract<StructuralGlyph, { kind: 'force' | 'moment' }> & { group: string };

/** The support and load glyphs of one model. */
export function structuralGlyphs(store: IfcDataStore, extraction: StructuralExtraction): StructuralGlyphSet {
  const reader = new ItemGeometryReader(store);
  const glyphs: StructuralGlyph[] = [];
  const unplaced: StructuralGlyphSource[] = [];
  const shapes = new Map<number, ItemShape | null>();
  /** The shape of an item or activity; a point one may stand at its placement origin. */
  const shapeOf = (id: number, type: string) => {
    if (!shapes.has(id)) shapes.set(id, expectedShape(type) === 'vertex' ? reader.pointShape(id) : reader.shape(id));
    return shapes.get(id)!;
  };

  /** A point connection's condition frame, in world axes. */
  const conditionFrame = (connection: StructuralExtraction['connections'][number]): Frame | null => {
    const product = reader.productFrame(connection.expressId);
    const ccs = connection.ConditionCoordinateSystem === undefined ? IDENTITY : reader.axisPlacement(connection.ConditionCoordinateSystem);
    return product && ccs ? compose(product, ccs) : null;
  };

  for (const connection of extraction.connections) {
    const support = structuralSupportKind(connection.appliedCondition);
    if (!support) continue;
    const shape = shapeOf(connection.expressId, connection.type);
    const frame = conditionFrame(connection);
    if (!shape || !frame) { unplaced.push(sourceOf(connection)); continue; }
    const direction = normalize(frame.z) ?? [0, 0, 1];
    for (const position of shapeStations(shape)) glyphs.push({ kind: 'support', support, position, direction, source: sourceOf(connection) });
  }

  const itemsByGlobalId = new Map<string, { expressId: number; type: string; Axis?: number; connection?: StructuralExtraction['connections'][number] }>();
  for (const m of extraction.members) itemsByGlobalId.set(m.globalId, { expressId: m.expressId, type: m.type, Axis: m.Axis });
  for (const c of extraction.connections) itemsByGlobalId.set(c.globalId, { expressId: c.expressId, type: c.type, connection: c });
  const loadGroups = new Set(extraction.loadGroups.map((g) => g.globalId));
  const pending: Pending[] = [];

  /** The frame `LOCAL_COORDS` loads of `activity` are given in. */
  const localFrame = (activity: StructuralActivityInfo, own: boolean, shape: ItemShape): Frame | null => {
    const item = activity.appliesToGlobalId ? itemsByGlobalId.get(activity.appliesToGlobalId) : undefined;
    if (shape.kind === 'vertex') {
      if (own || !item) return reader.productFrame(activity.expressId);
      return item.connection ? conditionFrame(item.connection) : reader.productFrame(item.expressId);
    }
    const axis = item && item.Axis !== undefined ? reader.productDirection(item.expressId, item.Axis) : null;
    return shapeFrame(shape, axis);
  };

  for (const activity of extraction.activities) {
    if (activity.kind !== 'Action' || !activity.appliedLoad || !drawable(activity.appliedLoad)) continue;
    const source = sourceOf(activity);
    const expected = expectedShape(activity.type);
    const ownShape = shapeOf(activity.expressId, activity.type);
    const item = activity.appliesToGlobalId ? itemsByGlobalId.get(activity.appliesToGlobalId) : undefined;
    const shape = ownShape?.kind === expected ? ownShape : item ? shapeOf(item.expressId, item.type) : null;
    const frame = shape?.kind === expected && activity.globalOrLocal === 'LOCAL_COORDS'
      ? localFrame(activity, ownShape?.kind === expected, shape)
      : IDENTITY;
    if (!shape || shape.kind !== expected || !frame) { unplaced.push(source); continue; }

    const group = activity.groupGlobalIds.find((id) => loadGroups.has(id)) ?? '';
    const distribution = DISTRIBUTION[shape.kind];
    const centre = shapeCentre(shape);
    const world = (v: Vec3): Vec3 => normalize(rotate(frame, v)) ?? [0, 0, 1];
    const parts = activity.appliedLoad.configuration
      ? activity.appliedLoad.configuration.entries.flatMap((entry) => {
        if (!entry.value) return [];
        const at = shape.kind === 'edge' && entry.location?.length
          ? pointAlong(shape.start, shape.end, reader.metres(entry.location[0]))
          : centre;
        return [{ load: entry.value, stations: [at], at }];
      })
      : [{ load: activity.appliedLoad, stations: shapeStations(shape), at: centre }];

    for (const { load, stations, at } of parts) {
      const force = vector(load, FORCE);
      if (force) {
        for (const position of stations) {
          pending.push({ kind: 'force', distribution, position, direction: world(force), magnitude: length(force), relative: 1, source, group });
        }
      }
      const moment = vector(load, MOMENT);
      if (moment) pending.push({ kind: 'moment', distribution, position: at, direction: world(moment), magnitude: length(moment), relative: 1, source, group });
      const displacement = vector(load, ['Displacement']);
      if (displacement || vector(load, ['RotationalDisplacementR'])) {
        glyphs.push(displacement ? { kind: 'displacement', position: at, direction: world(displacement), source } : { kind: 'displacement', position: at, source });
      }
      if (isTemperature(load)) {
        glyphs.push({ kind: 'temperature', position: at, source });
      }
    }
  }

  const largest = new Map<string, number>();
  const classOf = (g: Pending) => `${g.kind}|${g.distribution}|${g.group}`;
  for (const g of pending) largest.set(classOf(g), Math.max(largest.get(classOf(g)) ?? 0, g.magnitude));
  for (const { group: _group, ...g } of pending) {
    glyphs.push({ ...g, relative: g.magnitude / largest.get(`${g.kind}|${g.distribution}|${_group}`)! });
  }
  return { glyphs, unplaced };
}
