/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Speckle object graph → planned IFC elements (mapping v1). Pure: no I/O,
 * no model access. See docs/architecture/speckle-mapping.md for the table.
 *
 *   Objects.BuiltElements.Wall    → IfcWall   (straight location line, height, WALL_ATTR_WIDTH_PARAM)
 *   Objects.BuiltElements.Floor   → IfcSlab   (flat polygonal outline, FLOOR_ATTR_THICKNESS_PARAM)
 *   Objects.BuiltElements.Roof    → IfcRoof   (flat polygonal footprint, ROOF_ATTR_THICKNESS_PARAM)
 *   Objects.BuiltElements.Column  → IfcColumn (vertical, unrotated location line, `b` × `h`)
 *   Objects.BuiltElements.Beam    → IfcBeam   (straight location line, `b` × `h`)
 *
 * The body is rebuilt parametrically through the same `bim.store.add*`
 * builders `model.addElement` uses; `bim.store` has no tessellated-body
 * writer, so display meshes are counted and reported, never written.
 * Coordinates are made relative to the element's own Speckle level and
 * written into the one target storey.
 *
 * The walk is iterative with a global visited set (the output for an id is
 * a pure function of that id, so revisits are skipped, not re-counted).
 */

import type { AddBeamInStoreParams, AddColumnInStoreParams, AddRoofPolygonParams, AddSlabPolygonParams, AddWallInStoreParams } from '@ifc-lite/sdk';
import type { SpeckleObject } from './client.js';
import { DISPLAY_KEYS } from './client.js';
import { isA, leafType, lineOf, outlineOf, resolverFor, type Resolver, type Vec3 } from './geometry.js';
import { dimension, psetRows, readParameters, type ParamValue, type SpeckleParameter } from './parameters.js';
import { RefusalLog, type SpeckleRefusal, type SpeckleRefusalReason } from './refusals.js';
import { lengthScale } from './units.js';

export const PSET_SOURCE = 'Speckle_Source';
export const PSET_TYPE = 'Speckle_TypeParameters';
export const PSET_INSTANCE = 'Speckle_InstanceParameters';

type Header = Pick<AddWallInStoreParams, 'Name' | 'ObjectType' | 'Tag'>;

export type PlannedElement = {
  /** Stable identity across versions: the Revit `applicationId`, else the Speckle id. */
  readonly key: string;
  readonly speckleType: string;
  readonly speckleId: string;
  readonly psets: Readonly<Record<string, Readonly<Record<string, ParamValue>>>>;
  readonly displayMeshes: number;
  readonly skippedEntries: number;
} & (
  | { readonly kind: 'wall'; readonly params: AddWallInStoreParams }
  | { readonly kind: 'slab'; readonly params: AddSlabPolygonParams }
  | { readonly kind: 'roof'; readonly params: AddRoofPolygonParams }
  | { readonly kind: 'column'; readonly params: AddColumnInStoreParams }
  | { readonly kind: 'beam'; readonly params: AddBeamInStoreParams }
);

export interface MappingOptions {
  /** Only elements on this Speckle level (by name); empty = every level. */
  readonly level?: string;
}

export interface MappingResult {
  readonly planned: PlannedElement[];
  readonly refusals: RefusalLog;
}

type Kind = PlannedElement['kind'];
const KINDS: ReadonlyArray<[string, Kind]> = [
  ['Objects.BuiltElements.Wall', 'wall'],
  ['Objects.BuiltElements.Floor', 'slab'],
  ['Objects.BuiltElements.Roof', 'roof'],
  ['Objects.BuiltElements.Column', 'column'],
  ['Objects.BuiltElements.Beam', 'beam'],
];

const kindOf = (o: Record<string, unknown>): Kind | undefined => KINDS.find(([base]) => isA(o, base))?.[1];

function isContainer(o: Record<string, unknown>): boolean {
  const t = typeof o.speckle_type === 'string' ? o.speckle_type : 'Base';
  return t === 'Base' || isA(o, 'Speckle.Core.Models.Collections.Collection') || t.startsWith('Objects.Organization.');
}

/** Child slots a container is walked through: `elements` and dynamic `@`-detached members. */
function childSlots(o: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (DISPLAY_KEYS.has(k) || (k !== 'elements' && !k.startsWith('@'))) continue;
    if (Array.isArray(v)) out.push(...v);
    else if (v !== null && typeof v === 'object') out.push(v);
  }
  return out;
}

class Refused extends Error {
  constructor(readonly reason: SpeckleRefusalReason, detail: string) {
    super(detail);
  }
}

const TOL = 1e-4;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : v === null || v === undefined ? undefined : String(v));
const xy = (p: Vec3): [number, number] => [p[0], p[1]];

function required(params: readonly SpeckleParameter[], internal: string, label: string): number {
  const v = dimension(params, internal);
  if (v === undefined) throw new Refused('missing-dimension', `no positive ${internal} (${label}) parameter`);
  return v;
}

function line(resolve: Resolver, o: Record<string, unknown>): { start: Vec3; end: Vec3 } {
  const l = lineOf(resolve, o.baseLine, o.units);
  if ('reason' in l) throw new Refused('geometry', l.reason);
  return l;
}

function flatOutline(resolve: Resolver, o: Record<string, unknown>): Vec3[] {
  if (typeof o.slope === 'number' && Math.abs(o.slope) > 1e-9) throw new Refused('geometry', 'is sloped; v1 writes flat slabs and roofs only');
  if (Array.isArray(o.voids) && o.voids.length > 0) throw new Refused('openings', 'has openings (voids), which a v1 extrusion would fill in');
  const outline = outlineOf(resolve, o.outline, o.units);
  if ('reason' in outline) throw new Refused('geometry', outline.reason);
  return outline.points;
}

function plan(resolve: Resolver, o: SpeckleObject, kind: Kind, params: readonly SpeckleParameter[], elevation: number): Pick<PlannedElement, 'kind' | 'params'> {
  const header: Header = {
    Name: [str(o.family), str(o.type)].filter((s) => s !== undefined).join(': ') || leafType(o),
    ObjectType: str(o.type),
    Tag: str(o.elementId),
  };
  const local = (p: Vec3): [number, number, number] => [p[0], p[1], p[2] - elevation];
  switch (kind) {
    case 'wall': {
      const { start, end } = line(resolve, o);
      if (Math.abs(start[2] - end[2]) > TOL) throw new Refused('geometry', 'has a location line that is not horizontal');
      const height = typeof o.height === 'number' && o.height > 0 ? o.height * (lengthScale(o.units) ?? Number.NaN) : Number.NaN;
      if (!Number.isFinite(height)) throw new Refused('missing-dimension', 'no positive height');
      return { kind, params: { ...header, Start: local(start), End: local(end), Height: height, Thickness: required(params, 'WALL_ATTR_WIDTH_PARAM', 'Width') } };
    }
    case 'slab': {
      const points = flatOutline(resolve, o);
      const thickness = required(params, 'FLOOR_ATTR_THICKNESS_PARAM', 'Thickness');
      // A Revit floor's outline is its top face at the level: the slab hangs below it.
      return { kind, params: { ...header, Profile: 'polygon', OuterCurve: points.map(xy), Position: [0, 0, points[0][2] - elevation - thickness], Thickness: thickness } };
    }
    case 'roof': {
      if (isA(o, 'Objects.BuiltElements.Revit.RevitRoof.RevitExtrusionRoof')) throw new Refused('geometry', 'is an extrusion roof (a profile swept along a path)');
      const points = flatOutline(resolve, o);
      const thickness = required(params, 'ROOF_ATTR_THICKNESS_PARAM', 'Thickness');
      return { kind, params: { ...header, Profile: 'polygon', OuterCurve: points.map(xy), Position: [0, 0, points[0][2] - elevation], Thickness: thickness } };
    }
    case 'column': {
      const { start, end } = line(resolve, o);
      if (Math.abs(start[0] - end[0]) > TOL || Math.abs(start[1] - end[1]) > TOL) throw new Refused('geometry', 'is slanted; v1 writes vertical columns only');
      if (typeof o.rotation === 'number' && Math.abs(o.rotation) > 1e-9) throw new Refused('geometry', 'is rotated about its axis, which the column writer cannot express');
      const base = start[2] <= end[2] ? start : end;
      const height = Math.abs(end[2] - start[2]);
      if (height <= TOL) throw new Refused('missing-dimension', 'no height (zero-length location line)');
      return { kind, params: { ...header, Position: local(base), Height: height, Width: required(params, 'b', 'b'), Depth: required(params, 'h', 'h') } };
    }
    case 'beam': {
      const { start, end } = line(resolve, o);
      return { kind, params: { ...header, Start: local(start), End: local(end), Width: required(params, 'b', 'b'), Height: required(params, 'h', 'h') } };
    }
  }
}

function sourcePset(o: SpeckleObject, levelName: string | undefined): Record<string, ParamValue> {
  const rows: Record<string, ParamValue> = { SpeckleId: o.id, SpeckleType: String(o.speckle_type) };
  const add = (k: string, v: unknown) => {
    const s = str(v);
    if (s !== undefined) rows[k] = s;
  };
  add('ApplicationId', o.applicationId);
  add('Category', o.category);
  add('Family', o.family);
  add('Type', o.type);
  add('ElementId', o.elementId);
  add('Level', levelName);
  add('SourceUnits', o.units);
  return rows;
}

function mapElement(resolve: Resolver, o: SpeckleObject, kind: Kind, opts: MappingOptions, log: RefusalLog, planned: PlannedElement[]): void {
  const type = leafType(o);
  const level = resolve(o.level);
  const levelName = str(level?.name);
  if (opts.level && levelName !== opts.level) {
    log.add(type, 'other-level', `on level "${levelName ?? '(none)'}", not the requested level "${opts.level}"`, o.id);
    return;
  }
  const scale = lengthScale(o.units);
  if (scale === undefined) {
    log.add(type, 'no-units', `units "${String(o.units ?? '(none)')}" is not a length unit`, o.id);
    return;
  }
  const elevation = typeof level?.elevation === 'number' ? level.elevation * (lengthScale(level.units) ?? scale) : 0;
  const { parameters, skipped } = readParameters(resolve, o);
  try {
    const p = plan(resolve, o, kind, parameters, elevation);
    planned.push({
      ...p,
      key: str(o.applicationId) ?? o.id,
      speckleType: type,
      speckleId: o.id,
      psets: { [PSET_SOURCE]: sourcePset(o, levelName), [PSET_TYPE]: psetRows(parameters, 'type'), [PSET_INSTANCE]: psetRows(parameters, 'instance') },
      displayMeshes: Array.isArray(o.displayValue) ? o.displayValue.length : 0,
      skippedEntries: skipped,
    } as PlannedElement);
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    log.add(type, err.reason, err.message, o.id);
  }
}

/** Walk the fetched graph from its root and plan every mappable element. */
export function mapSpeckleGraph(objects: ReadonlyMap<string, SpeckleObject>, rootId: string, opts: MappingOptions = {}): MappingResult {
  const resolve = resolverFor(objects);
  const log = new RefusalLog();
  const planned: PlannedElement[] = [];
  const root = objects.get(rootId);
  if (!root) throw new Error(`speckle.receive: root object ${rootId} was not fetched`);
  const seen = new Set<string>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const o = resolve(stack.pop()) as SpeckleObject | undefined;
    if (!o || typeof o.id !== 'string' || seen.has(o.id)) continue;
    seen.add(o.id);
    const kind = kindOf(o);
    if (kind) mapElement(resolve, o, kind, opts, log, planned);
    else if (!isContainer(o)) {
      log.add(leafType(o), 'unmapped-type', 'has no v1 mapping', o.id);
      continue;
    }
    // Containers, and hosted elements under a mapped one (a stacked wall's
    // layers, a wall's doors), are walked in document order.
    const children = kind ? (Array.isArray(o.elements) ? o.elements : []) : childSlots(o);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return { planned, refusals: log };
}

export type { SpeckleRefusal };
