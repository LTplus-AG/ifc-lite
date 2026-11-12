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
 *   (the connection's `ConditionCoordinateSystem` when given; along an edge,
 *   z towards its Axis; over a face, the reference surface normal, else the
 *   face normal on the side of the placement z): the symbol hangs below the
 *   node, against it.
 * - for each action and each reaction (a reaction's glyphs carry
 *   `reaction: true`): the force resultant of X/Y/Z as an arrow per station,
 *   the moment resultant as one moment glyph, and a marker for a displacement
 *   or a temperature load. An IFC2X3 varying action draws its
 *   `SubsequentAppliedLoads` too (`varyingParts`). `GLOBAL_COORDS`
 *   loads are in the analysis model's `SharedPlacement` axes; `LOCAL_COORDS`
 *   loads in the activity's frame: its own face's reference surface, else
 *   the surface item's face frame, else the curve member's (x along the edge,
 *   z towards `Axis`), else its own placement or the point connection's
 *   condition frame (see `localFrame`). Load configurations draw each value
 *   at its location: a length along an edge, or x and y in a face's reference
 *   surface; on a face without a plane reference surface, or an entry
 *   without its location, at the centre.
 *
 * `relative` scales arrows within their load case (else first load group,
 * else first result group): the largest force (or moment) of the same
 * distribution in the same group is 1; an activity in no group scales on its
 * own. Units differ by distribution (N, N/m, N/m2), so each scales on its own.
 *
 * A point activity with no vertex of its own, on a curve or surface item,
 * stands where its own `ObjectPlacement` puts it on that item (see `placedOn`).
 */

import type { IfcDataStore } from './columnar-parser.js';
import type { StructuralActivityInfo, StructuralConnectionInfo, StructuralExtraction } from './structural-types.js';
import { extractStructuralLoad, type StructuralLoadInfo } from './structural-load-extractor.js';
import { EntityExtractor } from './entity-extractor.js';
import { structuralSupportKind, type StructuralSupportKind } from './structural-support-kind.js';
import { add, compose, IDENTITY, ItemGeometryReader, length, normalize, rotate, scale, sub, type Frame, type ItemShape, type Vec3 } from './structural-item-geometry.js';
import { onShape, pointAlong, pointIn, shapeCentre, shapeFrame, shapeStations } from './structural-glyph-stations.js';
import { varyingParts, type LoadPart } from './structural-glyph-varying.js';

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
  /** Drawn for a reaction (an analysis result), not an applied load or a support. */
  reaction?: true;
}

export type StructuralGlyph =
  /** `direction`: the support frame's Z, unit. */
  | (GlyphBase & { kind: 'support'; support: StructuralSupportKind; direction: Vec3 })
  /** `direction`: the force (or moment axis, right hand), unit. `magnitude` in the file's units; `relative` in (0, 1]. */
  | (GlyphBase & { kind: 'force' | 'moment'; distribution: StructuralLoadDistribution; direction: Vec3; magnitude: number; relative: number })
  /** `direction`: the translation, when the displacement has one. */
  | (GlyphBase & { kind: 'displacement'; direction?: Vec3 })
  | (GlyphBase & { kind: 'temperature' });

const DISTRIBUTION: Record<ItemShape['kind'], StructuralLoadDistribution> = { vertex: 'point', edge: 'linear', face: 'planar' };

/**
 * A load's own distribution by its type (a `DISCRETE` curve action may hold
 * single forces), else the shape's.
 */
function distributionOf(load: StructuralLoadInfo, shape: ItemShape['kind']): StructuralLoadDistribution {
  if (/Single/.test(load.type)) return 'point';
  if (/Linear/.test(load.type)) return 'linear';
  if (/Planar/.test(load.type)) return 'planar';
  return DISTRIBUTION[shape];
}

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
 * not drawn.
 */
function drawable(load: StructuralLoadInfo): boolean {
  if (load.configuration) return load.configuration.entries.some((e) => !!e.value && drawable(e.value));
  return !!(vector(load, FORCE) || vector(load, MOMENT) || vector(load, ['Displacement']) || vector(load, ['RotationalDisplacementR']) || isTemperature(load));
}

/** A curve connection's Axis: `Axis` in IFC4, `AxisDirection` in IFC4X3. */
const connectionAxis = (c: StructuralConnectionInfo) => c.Axis ?? c.AxisDirection;

const sourceOf = (e: { expressId: number; globalId: string; type: string }): StructuralGlyphSource =>
  ({ expressId: e.expressId, globalId: e.globalId, type: e.type });

/** The member or connection an activity acts on. */
interface ItemRef {
  expressId: number;
  type: string;
  /** A curve member's or curve connection's `Axis` direction (model-local expressId). */
  Axis?: number;
  connection?: StructuralConnectionInfo;
  analysisModelGlobalIds: string[];
}

type Arrow = Extract<StructuralGlyph, { kind: 'force' | 'moment' }>;
type Pending = Omit<Arrow, 'relative'> & { group: string };

/**
 * The support and load glyphs of one model. A supported connection or an
 * action with a load that cannot be placed (no topology representation of the
 * expected kind on it or on the item it acts on, or a placement this reader
 * does not follow) draws nothing, never a glyph at a guessed position.
 */
export function structuralGlyphs(store: IfcDataStore, extraction: StructuralExtraction): StructuralGlyph[] {
  const reader = new ItemGeometryReader(store);
  const glyphs: StructuralGlyph[] = [];
  const shapes = new Map<number, ItemShape | null>();
  /** An item's shape; a point connection may stand at its placement origin. */
  const itemShape = (id: number, type: string) => {
    if (!shapes.has(id)) shapes.set(id, expectedShape(type) === 'vertex' ? reader.pointShape(id) : reader.shape(id));
    return shapes.get(id)!;
  };

  /** An item's `Axis` direction in world axes, or null when it has none. */
  const edgeAxis = (id: number, ref: number | undefined) => (ref === undefined ? null : reader.productDirection(id, ref));
  /** A point connection's condition frame, in world axes. */
  const conditionFrame = (connection: StructuralConnectionInfo): Frame | null => {
    const product = reader.productFrame(connection.expressId);
    const ccs = connection.ConditionCoordinateSystem === undefined ? IDENTITY : reader.axisPlacement(connection.ConditionCoordinateSystem);
    return product && ccs ? compose(product, ccs) : null;
  };

  for (const connection of extraction.connections) {
    const support = structuralSupportKind(connection.appliedCondition, store.schemaVersion);
    if (!support) continue;
    const shape = itemShape(connection.expressId, connection.type);
    const frame = conditionFrame(connection);
    if (!shape || !frame) continue;
    // A curve connection's frame has x along the edge and z towards its Axis;
    // a surface connection's is its face frame, on the side of its placement z.
    const axis = shape.kind === 'edge' ? edgeAxis(connection.expressId, connectionAxis(connection)) : null;
    const local = shape.kind === 'face' ? shapeFrame(shape, frame.z) : axis && shapeFrame(shape, axis);
    const direction = normalize(local?.z ?? frame.z) ?? [0, 0, 1];
    for (const position of shapeStations(shape)) glyphs.push({ kind: 'support', support, position, direction, source: sourceOf(connection) });
  }

  const itemsByGlobalId = new Map<string, ItemRef>();
  for (const m of extraction.members) itemsByGlobalId.set(m.globalId, { expressId: m.expressId, type: m.type, Axis: m.Axis, analysisModelGlobalIds: m.analysisModelGlobalIds });
  for (const c of extraction.connections) itemsByGlobalId.set(c.globalId, { expressId: c.expressId, type: c.type, Axis: connectionAxis(c), connection: c, analysisModelGlobalIds: c.analysisModelGlobalIds });
  // GLOBAL_COORDS is the analysis model's coordinate system: its
  // SharedPlacement, or IFC world when it has none (IFC2X3 has none). An
  // unreadable SharedPlacement (null) refuses the model's loads. The model is
  // the one the activity is assigned to, else its item's, else the one model
  // that is LoadedBy its load group (a group several models load decides
  // nothing), else the file's only model.
  const modelFrames = new Map<string, Frame | null>();
  /** The one model LoadedBy a load group; null once a second model loads it. */
  const groupModel = new Map<string, string | null>();
  for (const m of extraction.analysisModels) {
    const frame = reader.sharedPlacementFrame(m.expressId);
    modelFrames.set(m.globalId, frame === undefined ? IDENTITY : frame);
    for (const g of m.loadGroupGlobalIds) {
      const seen = groupModel.get(g);
      groupModel.set(g, seen === undefined || seen === m.globalId ? m.globalId : null);
    }
  }
  const onlyModelFrame = extraction.analysisModels.length === 1 ? modelFrames.get(extraction.analysisModels[0].globalId)! : IDENTITY;
  const firstFrame = (ids: readonly string[], lookup: (id: string) => Frame | null | undefined): Frame | null | undefined => {
    for (const id of ids) {
      const frame = lookup(id);
      if (frame !== undefined) return frame;
    }
    return undefined;
  };
  const globalFrame = (activity: StructuralActivityInfo, item: ItemRef | undefined): Frame | null => {
    const direct = firstFrame([...activity.groupGlobalIds, ...(item?.analysisModelGlobalIds ?? [])], (id) => modelFrames.get(id));
    if (direct !== undefined) return direct;
    const viaGroup = firstFrame(activity.groupGlobalIds, (id) => {
      const model = groupModel.get(id);
      return model ? modelFrames.get(model) : undefined;
    });
    // `null` (a refused model) is an answer, so no `??` here.
    return viaGroup === undefined ? onlyModelFrame : viaGroup;
  };
  const loadGroups = new Map(extraction.loadGroups.map((g) => [g.globalId, g.type]));
  const resultGroups = new Set(extraction.resultGroups.map((g) => g.globalId));
  const pending: Pending[] = [];
  const extractor = new EntityExtractor(store.source);
  /** An activity's loads in station order: `AppliedLoad`, then an IFC2X3 varying action's `SubsequentAppliedLoads`. */
  const loadsOf = (activity: StructuralActivityInfo): StructuralLoadInfo[] => [
    activity.appliedLoad!,
    ...(activity.SubsequentAppliedLoads ?? []).map((id) => extractStructuralLoad(extractor, store, id)).filter((l): l is StructuralLoadInfo => !!l),
  ];

  /**
   * A point activity's position on the curve or surface item it acts on,
   * when it has no vertex of its own: the origin of its own placement (not
   * the item's), where that lies on the item; else that origin read in the
   * item's edge frame (x along the edge from its start), where that lies on
   * it. AxisVM writes the second: a station along the member as the origin's
   * x. Anything else is not drawn.
   */
  const placedOn = (activityId: number, item: ItemRef, host: ItemShape): ItemShape | null => {
    const origin = reader.placementOrigin(activityId);
    if (!origin || length(sub(origin, reader.placementOrigin(item.expressId) ?? [0, 0, 0])) < 1e-9) return null;
    if (onShape(host, origin)) return { kind: 'vertex', point: origin };
    const frame = host.kind === 'edge' ? shapeFrame(host, edgeAxis(item.expressId, item.Axis)) : null;
    const along = frame && add(pointIn(frame, origin[0], origin[1]), scale(frame.z, origin[2]));
    return along && onShape(host, along) ? { kind: 'vertex', point: along } : null;
  };

  /**
   * The frame `LOCAL_COORDS` loads are given in. An activity's own face with
   * a reference surface takes that surface. Otherwise an activity on a
   * surface item takes the item's face frame (its reference surface, else
   * its face normal turned to the item's placement z), an edge on it taking z
   * from that frame; none when that face has no frame (nothing is guessed).
   * Otherwise: an edge, x along it and z towards the item's
   * Axis; a point on a curve item, that item's edge frame; an own bare face,
   * its normal turned to the activity's placement z; a point, its own
   * placement when it draws at its own vertex, else the connection's
   * condition frame.
   */
  const localFrame = (activity: StructuralActivityInfo, item: ItemRef | undefined, own: boolean, shape: ItemShape): Frame | null => {
    if (own && shape.kind === 'face' && shape.surface) return shapeFrame(shape, null);
    const zOf = (id: number) => reader.productFrame(id)?.z ?? null;
    const host = item ? itemShape(item.expressId, item.type) : null;
    if (item && host?.kind === 'face') {
      const surface = shapeFrame(host, zOf(item.expressId));
      return surface && (shape.kind === 'edge' ? shapeFrame(shape, surface.z) : surface);
    }
    if (shape.kind === 'face') return shapeFrame(shape, zOf(activity.expressId));
    const axis = () => (item ? edgeAxis(item.expressId, item.Axis) : null);
    if (shape.kind === 'edge') return shapeFrame(shape, axis());
    if (host?.kind === 'edge') return shapeFrame(host, axis());
    if (own || !item) return reader.productFrame(activity.expressId);
    return item.connection ? conditionFrame(item.connection) : reader.productFrame(item.expressId);
  };

  for (const activity of extraction.activities) {
    if (activity.kind === 'Unknown' || !activity.appliedLoad) continue;
    const loads = loadsOf(activity);
    if (!loads.some(drawable)) continue;
    const source = sourceOf(activity);
    const reaction = activity.kind === 'Reaction' ? { reaction: true as const } : {};
    const expected = expectedShape(activity.type);
    const item = activity.appliesToGlobalId ? itemsByGlobalId.get(activity.appliesToGlobalId) : undefined;
    // An activity's own representation, else (a point on a curve or surface
    // item) its own placement checked against the item (`placedOn`), else the
    // item it acts on. A bare placement origin alone is never a position:
    // activities often share it with the item or the model.
    const own = reader.shape(activity.expressId);
    const ownShape = own?.kind === expected ? own : null;
    const host = item ? itemShape(item.expressId, item.type) : null;
    const placed = !ownShape && item && host && expected === 'vertex' && host.kind !== 'vertex' ? placedOn(activity.expressId, item, host) : null;
    const shape = ownShape ?? placed ?? host;
    if (!shape || shape.kind !== expected) continue;
    const frame = activity.globalOrLocal === 'LOCAL_COORDS' ? localFrame(activity, item, ownShape !== null, shape) : globalFrame(activity, item);
    if (!frame) continue;

    // Prefer the first assigned IfcStructuralLoadCase, otherwise the first load
    // group in assignment order. Ungrouped actions scale on their own (#9828).
    const group = activity.groupGlobalIds.find((id) => loadGroups.get(id) === 'IfcStructuralLoadCase')
      ?? activity.groupGlobalIds.find((id) => loadGroups.has(id) || resultGroups.has(id)) ?? `#${activity.expressId}`;
    const centre = shapeCentre(shape);
    const world = (v: Vec3): Vec3 => normalize(rotate(frame, v)) ?? [0, 0, 1];
    const parts: LoadPart[] = loads.length > 1 ? varyingParts(shape, loads, drawable) : activity.appliedLoad.configuration
      ? activity.appliedLoad.configuration.entries.flatMap((entry) => {
        if (!entry.value) return [];
        // A curve configuration's location is a length along the edge; a
        // surface one's is x and y in the reference surface.
        const [u, v] = (entry.location ?? []).map((l) => reader.metres(l));
        const at = shape.kind === 'edge' && u !== undefined ? pointAlong(shape.start, shape.end, u)
          : shape.kind === 'face' && shape.surface && v !== undefined ? pointIn(shape.surface, u, v)
            : centre;
        return [{ load: entry.value, stations: [at], at }];
      })
      : [{ load: activity.appliedLoad, stations: shapeStations(shape), at: centre }];

    for (const { load, stations, at } of parts) {
      const distribution = distributionOf(load, shape.kind);
      const force = vector(load, FORCE);
      if (force) {
        for (const position of stations) {
          pending.push({ kind: 'force', distribution, position, direction: world(force), magnitude: length(force), source, group, ...reaction });
        }
      }
      const moment = vector(load, MOMENT);
      if (moment) pending.push({ kind: 'moment', distribution, position: at, direction: world(moment), magnitude: length(moment), source, group, ...reaction });
      const displacement = vector(load, ['Displacement']);
      if (displacement || vector(load, ['RotationalDisplacementR'])) {
        glyphs.push({ kind: 'displacement', position: at, source, ...reaction, ...(displacement ? { direction: world(displacement) } : {}) });
      }
      if (isTemperature(load)) {
        glyphs.push({ kind: 'temperature', position: at, source, ...reaction });
      }
    }
  }

  const largest = new Map<string, number>();
  const classOf = (g: Pending) => `${g.kind}|${g.distribution}|${g.group}`;
  for (const g of pending) largest.set(classOf(g), Math.max(largest.get(classOf(g)) ?? 0, g.magnitude));
  for (const p of pending) {
    const { group: _group, ...arrow } = p;
    glyphs.push({ ...arrow, relative: p.magnitude / largest.get(classOf(p))! });
  }
  return glyphs;
}
