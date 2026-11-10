/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Roof by footprint in a loaded model (#9296 round 3): an `IfcRoof` whose body
 * holds one solid per roof plane, planned by `roof-footprint-plan.ts`.
 *
 * Each plane is an `IfcExtrudedAreaSolid`: its outline lies in the plane's
 * underside and is swept straight up by the thickness over the cosine of the
 * slope. The roof is then `Thickness` thick square to every plane, with plumb
 * eaves and vertical gable ends, from one swept-solid kind the kernel already
 * meshes. Hips and ridges between planes of one slope meet exactly; where the
 * slopes differ, the tops meet with a step of Thickness * (1/cos a - 1/cos b). One `IfcRoof` carrying its own body keeps
 * the convention of `IfcCreator.addIfcGableRoof`.
 *
 * The footprint, slopes, overhang and thickness are recorded on the roof as
 * `IfcLite_RoofFootprint`, so `editFootprintRoofInStore` can change one edge's
 * slope or the overhang and rebuild the planes as one atomic edit.
 */

import { refreshTopAttachmentsInStore } from './top-attachment-refresh.js';
import { PropertyValueType } from '@ifc-lite/data';
import { effectiveReferencers } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { toNativeLength, type SpatialAnchor } from './anchor.js';
import { emitExtrudedSolid, emitPolygonProfile } from './_emit-helpers.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { refId } from './host-geometry-frame.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { heightAt, openFootprint, planFootprintRoof, type FootprintRoofPlan, type RoofShapeType } from './roof-footprint-plan.js';

export const ROOF_FOOTPRINT_PSET = 'IfcLite_RoofFootprint';

/** The footprint form of `addRoof`: either field present selects it. */
export interface RoofFootprintFields {
  /**
   * Slope of each footprint edge, radians, in outline order: edge i runs from
   * point i to point i+1 (a rectangle's from its corner along +X, then
   * anticlockwise). 0 is no slope: a gable end, or the high side of a
   * mono-pitch roof. Omitted: every edge is unsloped (a flat roof).
   */
  EdgeSlopes?: number[];
  /** Horizontal overhang beyond every edge, metres. Eaves drop with their plane. Default 0. */
  Overhang?: number;
}

/** A roof by footprint as recorded on the roof: metres and radians, placement-local. */
export interface FootprintRoofDefinition {
  readonly Footprint: Array<[number, number]>;
  readonly EdgeSlopes: number[];
  readonly Overhang: number;
  readonly Thickness: number;
  readonly PredefinedType: RoofShapeType;
}

/** One edit of a roof by footprint. Unnamed fields keep their value. */
export interface RoofFootprintEdit {
  /** Every edge's slope at once, radians, one per footprint edge. */
  readonly EdgeSlopes?: number[];
  /** One edge's slope, radians; applied after `EdgeSlopes`. */
  readonly Edge?: { readonly Index: number; readonly Slope: number };
  /** Metres. */
  readonly Overhang?: number;
  /** Metres, square to each plane. */
  readonly Thickness?: number;
}

export interface FootprintRoofBody {
  readonly shapeRepId: number;
  readonly productShapeId: number;
  readonly solidIds: number[];
  readonly profileIds: number[];
}

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Solids for each plane (or the flat slab), in the file's native length unit. */
function emitPlaneSolids(editor: StoreEditor, plan: FootprintRoofPlan, thickness: number): { solidIds: number[]; profileIds: number[] } {
  const solidIds: number[] = [], profileIds: number[] = [];
  if (plan.planes.length === 0) {
    const profileId = emitPolygonProfile(editor, plan.eaves);
    profileIds.push(profileId);
    solidIds.push(emitExtrudedSolid(editor, profileId, thickness));
    return { solidIds, profileIds };
  }
  for (const plane of plan.planes) {
    const [dx, dy] = plane.direction, sin = Math.sin(plane.slope), cos = Math.cos(plane.slope);
    // X along the pivot line, Y up the slope, Z the plane's upward normal.
    const x: Vec3 = [dx, dy, 0], y: Vec3 = [-dy * cos, dx * cos, sin], z: Vec3 = [dy * sin, -dx * sin, cos];
    const local = plane.outline.map((p): [number, number] => {
      const q: Vec3 = [p[0] - plane.origin[0], p[1] - plane.origin[1], heightAt(plane, p)];
      return [dot(q, x), dot(q, y)];
    });
    const profileId = emitPolygonProfile(editor, local);
    const origin = editor.addEntity('IfcCartesianPoint', [[plane.origin[0], plane.origin[1], 0]]).expressId;
    const axis = editor.addEntity('IfcDirection', [z]).expressId;
    const ref = editor.addEntity('IfcDirection', [x]).expressId;
    const position = editor.addEntity('IfcAxis2Placement3D', [`#${origin}`, `#${axis}`, `#${ref}`]).expressId;
    // World up, in the plane's frame: a vertical sweep gives plumb eaves and a perpendicular thickness.
    const up = editor.addEntity('IfcDirection', [[0, sin, cos]]).expressId;
    profileIds.push(profileId);
    solidIds.push(editor.addEntity('IfcExtrudedAreaSolid', [`#${profileId}`, `#${position}`, `#${up}`, thickness / cos]).expressId);
  }
  return { solidIds, profileIds };
}

/** Plan, in native units, and refuse a thickness that is not a length. */
export function planFootprintRoofNative(
  anchor: Pick<SpatialAnchor, 'lengthUnitScale'>, definition: Omit<FootprintRoofDefinition, 'PredefinedType'>,
): FootprintRoofPlan {
  if (!Number.isFinite(definition.Thickness) || definition.Thickness <= 0) throw new Error('Thickness must be a positive length');
  const footprint = definition.Footprint.map((p) => [toNativeLength(anchor, p[0]), toNativeLength(anchor, p[1])] as [number, number]);
  return planFootprintRoof(footprint, definition.EdgeSlopes, toNativeLength(anchor, definition.Overhang));
}

/** The body of a roof by footprint: one Body representation holding every plane's solid. */
export function emitFootprintRoofBody(
  editor: StoreEditor, anchor: Pick<SpatialAnchor, 'lengthUnitScale'>, bodyContextId: number,
  definition: Omit<FootprintRoofDefinition, 'PredefinedType'>,
): FootprintRoofBody & { plan: FootprintRoofPlan } {
  const plan = planFootprintRoofNative(anchor, definition);
  const { solidIds, profileIds } = emitPlaneSolids(editor, plan, toNativeLength(anchor, definition.Thickness));
  const shapeRepId = editor.addEntity('IfcShapeRepresentation', [
    `#${bodyContextId}`, 'Body', 'SweptSolid', solidIds.map((id) => `#${id}`),
  ]).expressId;
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [null, null, [`#${shapeRepId}`]]).expressId;
  return { shapeRepId, productShapeId, solidIds, profileIds, plan };
}

/** The `IfcLite_RoofFootprint` properties a definition is recorded as, in metres and radians. */
export function footprintDefinitionProperties(definition: FootprintRoofDefinition): Array<[name: string, value: string | number, type: PropertyValueType]> {
  return [
    ['Footprint', JSON.stringify(definition.Footprint), PropertyValueType.Text],
    ['EdgeSlopes', JSON.stringify(definition.EdgeSlopes), PropertyValueType.Text],
    ['Overhang', definition.Overhang, PropertyValueType.Real],
    ['Thickness', definition.Thickness, PropertyValueType.Real],
  ];
}

/** Record the definition on the roof. */
export function writeFootprintDefinition(view: MutablePropertyView, roofId: number, definition: FootprintRoofDefinition): void {
  for (const [name, value, type] of footprintDefinitionProperties(definition)) view.setProperty(roofId, ROOF_FOOTPRINT_PSET, name, value, type);
}

/** Preserve edge styles; a split inherits its flat source, and a merge requires one uniform style. */
function carryPlaneStyles(store: IfcDataStore, draft: StoreEditor, replacements: ReadonlyMap<number, readonly number[]>): void {
  const reader = new AnchorEntityReader(store, draft.getMutationView());
  const styled: Array<{ id: number; item: number; styles: string[]; name: string | null; key: string }> = [];
  for (const id of reader.ids('IFCSTYLEDITEM')) {
    const entity = reader.entity(id);
    const item = refId(entity?.attributes[0]);
    if (!entity || item === null || !replacements.has(item)) continue;
    const styles = entity.attributes[1];
    const name = entity.attributes[2];
    if (!Array.isArray(styles) || styles.length === 0 || styles.some((v) => refId(v) === null)) throw new Error('Unreadable roof plane style');
    if (name !== null && name !== undefined && typeof name !== 'string') throw new Error('Unreadable roof plane style name');
    const refs = styles.map((v) => `#${refId(v)}`).sort();
    styled.push({ id, item, styles: refs, name: name ?? null, key: JSON.stringify([refs, name ?? null]) });
  }
  const targets = [...replacements.values()];
  const merging = targets.length > 1 && targets.every(ids => ids.length === 1 && ids[0] === targets[0][0]);
  if (merging && styled.length && (new Set(styled.map(style => style.item)).size !== replacements.size || new Set(styled.map(style => style.key)).size !== 1)) {
    throw new Error('Cannot merge roof planes with different styles into one flat plane; assign one common style first');
  }
  const written = new Map<number, string>();
  for (const style of styled) {
    for (const item of replacements.get(style.item)!) {
      const previous = written.get(item);
      if (previous !== undefined && previous !== style.key) throw new Error('Cannot merge roof planes with different styles');
      if (previous === undefined) {
        draft.addEntity('IfcStyledItem', [`#${item}`, style.styles, style.name]);
        written.set(item, style.key);
      }
    }
    draft.removeEntity(style.id);
  }
}

/** The entity kinds a plane solid is built from; nothing else is collected with it. */
const PLANE_GEOMETRY = new Set([
  'IFCEXTRUDEDAREASOLID', 'IFCARBITRARYCLOSEDPROFILEDEF', 'IFCRECTANGLEPROFILEDEF', 'IFCPOLYLINE',
  'IFCCARTESIANPOINT', 'IFCDIRECTION', 'IFCAXIS2PLACEMENT2D', 'IFCAXIS2PLACEMENT3D',
]);

/**
 * Remove the replaced planes' solids and what they are built from, where nothing
 * outside them refers to it. The walk is bounded by a visited set and stops at
 * anything that is not plane geometry.
 */
function removeReplacedPlanes(store: IfcDataStore, draft: StoreEditor, itemIds: readonly number[]): void {
  const view = draft.getMutationView();
  const reader = new AnchorEntityReader(store, view);
  const found = new Set<number>();
  const stack = [...itemIds];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const id = refId(value);
    if (id !== null) stack.push(id);
  };
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (found.has(id)) continue;
    const entity = reader.entity(id);
    if (!entity || !PLANE_GEOMETRY.has(entity.type.toUpperCase())) continue;
    found.add(id);
    entity.attributes.forEach(visit);
  }
  const referencers = effectiveReferencers(store, view);
  // Keep anything still used from outside the replaced planes, and what it uses in turn.
  for (let changed = true; changed;) {
    changed = false;
    for (const id of found) {
      if (referencers(id).some((parent) => !found.has(parent))) { found.delete(id); changed = true; }
    }
  }
  for (const id of found) draft.removeEntity(id);
}

function assertRoofEdit(patch: RoofFootprintEdit): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('A roof edit must be an object');
  for (const name of Object.keys(patch)) {
    if (!['EdgeSlopes', 'Edge', 'Overhang', 'Thickness'].includes(name)) throw new Error(`Unsupported roof edit field ${name}`);
  }
  if (patch.EdgeSlopes !== undefined && !Array.isArray(patch.EdgeSlopes)) throw new Error('EdgeSlopes must be an array of radians, one per footprint edge');
  const edge = patch.Edge as unknown;
  if (edge !== undefined && (edge === null || typeof edge !== 'object' || Array.isArray(edge)
    || typeof (edge as { Slope?: unknown }).Slope !== 'number' || !Number.isInteger((edge as { Index?: unknown }).Index))) {
    throw new Error('Edge must be { Index: footprint edge number, Slope: radians }');
  }
  for (const name of ['Overhang', 'Thickness'] as const) {
    if (patch[name] !== undefined && typeof patch[name] !== 'number') throw new Error(`${name} must be a length in metres`);
  }
}

function parseNumbers(value: unknown, pairs: boolean): unknown {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const ok = parsed.every((v) => pairs
      ? Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === 'number' && Number.isFinite(c))
      : typeof v === 'number' && Number.isFinite(v));
    return ok ? parsed : null;
  } catch (error) {
    console.warn('[roof] unreadable IfcLite_RoofFootprint value', error);
    return null;
  }
}

/** The recorded definition of a roof by footprint, or null when `roofId` is not one. */
export function readFootprintRoofInStore(store: IfcDataStore, roofId: number, view: MutablePropertyView): FootprintRoofDefinition | null {
  const roof = new AnchorEntityReader(store, view).entity(roofId);
  if (roof?.type.toUpperCase() !== 'IFCROOF') return null;
  const footprint = parseNumbers(view.getPropertyValue(roofId, ROOF_FOOTPRINT_PSET, 'Footprint'), true) as Array<[number, number]> | null;
  const slopes = parseNumbers(view.getPropertyValue(roofId, ROOF_FOOTPRINT_PSET, 'EdgeSlopes'), false) as number[] | null;
  const overhang = view.getPropertyValue(roofId, ROOF_FOOTPRINT_PSET, 'Overhang');
  const thickness = view.getPropertyValue(roofId, ROOF_FOOTPRINT_PSET, 'Thickness');
  if (!footprint || !slopes || typeof overhang !== 'number' || typeof thickness !== 'number') return null;
  const type = roof.attributes[8];
  const PredefinedType = (typeof type === 'string' ? type.replace(/\./g, '') : 'NOTDEFINED') as RoofShapeType;
  return { Footprint: footprint, EdgeSlopes: slopes, Overhang: overhang, Thickness: thickness, PredefinedType };
}

/**
 * Change a roof by footprint (one edge's slope, all slopes, the overhang or the
 * thickness) and rebuild its planes, as one atomic edit: a refusal writes nothing.
 * Identity, placement, containment and properties are kept; the body is replaced.
 */
export function editFootprintRoofInStore(store: IfcDataStore, editor: StoreEditor, roofId: number, patch: RoofFootprintEdit): FootprintRoofDefinition {
  return editor.runAtomic((draft) => {
    const view = draft.getMutationView();
    const current = readFootprintRoofInStore(store, roofId, view);
    if (!current) throw new Error(`#${roofId} is not a roof by footprint (it has no ${ROOF_FOOTPRINT_PSET} definition)`);
    assertRoofEdit(patch);
    const slopes = [...(patch.EdgeSlopes ?? current.EdgeSlopes)];
    if (patch.Edge !== undefined) {
      const { Index } = patch.Edge;
      if (!Number.isInteger(Index) || Index < 0 || Index >= slopes.length) {
        throw new Error(`Edge.Index must be a footprint edge, 0 to ${slopes.length - 1}`);
      }
      slopes[Index] = patch.Edge.Slope;
    }
    const next = { Footprint: current.Footprint, EdgeSlopes: slopes, Overhang: patch.Overhang ?? current.Overhang, Thickness: patch.Thickness ?? current.Thickness };

    const reader = new AnchorEntityReader(store, view);
    const roof = reader.entity(roofId)!;
    const shapeId = refId(roof.attributes[6]);
    const shape = shapeId === null ? null : reader.entity(shapeId);
    const reps = shape?.attributes[2];
    const bodyRepId = Array.isArray(reps) ? reps.map(refId).find((id) => id !== null && reader.entity(id)?.attributes[1] === 'Body') : undefined;
    const contextId = bodyRepId == null ? null : refId(reader.entity(bodyRepId)?.attributes[0]);
    if (shapeId === null || bodyRepId == null || contextId === null || !Array.isArray(reps) || reps.length !== 1) {
      throw new Error(`The roof #${roofId} no longer has the single Body representation its footprint built`);
    }
    const oldItems = reader.entity(bodyRepId)?.attributes[3];
    const scale = { lengthUnitScale: getModelLengthUnitScale(store) };
    const body = emitFootprintRoofBody(draft, scale, contextId, next);
    draft.setPositionalAttribute(roofId, 6, `#${body.productShapeId}`);
    // The replaced shape and representation would otherwise remain as orphans (ShapeOfProduct [1:?]).
    const referencers = effectiveReferencers(store, view);
    if (referencers(shapeId).length === 0) {
      draft.removeEntity(shapeId);
      if (referencers(bodyRepId).every((parent) => parent === shapeId)) {
        draft.removeEntity(bodyRepId);
        const replaced = Array.isArray(oldItems) ? oldItems.map(refId).filter((id): id is number => id !== null) : [];
        const oldPlan = planFootprintRoofNative(scale, current);
        const oldEdges = oldPlan.planes.length ? oldPlan.planes.map((plane) => plane.edge) : [-1];
        const newEdges = body.plan.planes.length ? body.plan.planes.map((plane) => plane.edge) : [-1];
        carryPlaneStyles(store, draft, new Map(replaced.map((id, index): [number, readonly number[]] => {
          const edge = oldEdges[index];
          const next = newEdges.indexOf(edge);
          return [id, edge === -1 ? body.solidIds : newEdges[0] === -1 ? [body.solidIds[0]] : next < 0 ? [] : [body.solidIds[next]]];
        })));
        removeReplacedPlanes(store, draft, replaced);
      }
    }
    if (roof.attributes.length > 8) draft.setPositionalAttribute(roofId, 8, `.${body.plan.shapeType}.`);
    const definition = { ...next, PredefinedType: body.plan.shapeType };
    writeFootprintDefinition(view, roofId, definition);
    refreshTopAttachmentsInStore({ dataStore: store, view, editor: draft }, [roofId]);
    return definition;
  });
}

/** Footprint params in metres to a recorded definition (lengths as given, in metres). */
export function footprintDefinition(footprint: Array<[number, number]>, fields: RoofFootprintFields, thickness: number): Omit<FootprintRoofDefinition, 'PredefinedType'> {
  // One point per edge: a repeated closing point would count an edge that is not there.
  const points = openFootprint(footprint);
  const slopes = fields.EdgeSlopes === undefined ? points.map(() => 0) : fields.EdgeSlopes;
  if (!Array.isArray(slopes)) throw new Error('EdgeSlopes must be an array of radians, one per footprint edge');
  const overhang = fields.Overhang === undefined ? 0 : fields.Overhang;
  if (typeof overhang !== 'number') throw new Error('Overhang must be a length in metres');
  return { Footprint: points, EdgeSlopes: [...slopes], Overhang: overhang, Thickness: thickness };
}
