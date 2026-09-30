/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict occurrence edits of the single stepped flight built by stair.ts
 * (#6232). No inferred box, mapped shape, landing or multi-flight rewrite. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { AnchorEntityReader } from './resolve-anchor.js';
import { axis3d, contextDimension, pointOf, refId, type Vec3 } from './host-geometry-frame.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import { toNativeLength } from './anchor.js';
import { assertStairParams, emitStairFlightBody, stairFlightOutline } from './stair.js';

export interface StairDimensions {
  readonly stairId: number;
  readonly flightId: number;
  readonly NumberOfRisers: number;
  /** Metres, measured from the held flight foot. */
  readonly Width: number;
  readonly RiserHeight: number;
  readonly TreadLength: number;
  /** Absent for a flight solid down to its base. */
  readonly WaistThickness?: number;
}

export type StairDimensionEdit = Partial<Pick<StairDimensions, 'Width' | 'RiserHeight' | 'TreadLength' | 'WaistThickness'>>;

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));
const vectorIs = (a: Vec3, b: Vec3) => a.every((v, i) => close(v, b[i]));
const ref = (id: number) => `#${id}`;
// schemaAttributes emits explicit REAL wrappers; parsed source is numeric.
function number(value: unknown): number | null {
  const raw = typeof value === 'object' && value !== null && 'real' in value ? value.real : value;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function read(store: IfcDataStore, reader: AnchorEntityReader, id: number) {
  if (!['IFC2X3', 'IFC4', 'IFC4X3'].includes(store.schemaVersion ?? 'IFC4')) return null;
  const selected = reader.entity(id);
  if (!selected || !['IFCSTAIR', 'IFCSTAIRFLIGHT'].includes(selected.type.toUpperCase())) return null;
  const parents: Array<{ stairId: number; flightId: number }> = [];
  const aggregateCounts = new Map<number, number>();
  for (const relId of reader.ids('IFCRELAGGREGATES')) {
    const rel = reader.entity(relId);
    const parentId = rel ? refId(rel.attributes[4]) : null;
    const members = rel?.attributes[5];
    if (parentId !== null) aggregateCounts.set(parentId, (aggregateCounts.get(parentId) ?? 0) + 1);
    if (!Array.isArray(members)) continue;
    if (parentId !== id && !members.some(v => refId(v) === id)) continue;
    if (members.length !== 1 || parentId === null) return null;
    const flightId = refId(members[0]);
    if (flightId === null || reader.entity(parentId)?.type.toUpperCase() !== 'IFCSTAIR'
      || reader.entity(flightId)?.type.toUpperCase() !== 'IFCSTAIRFLIGHT') return null;
    parents.push({ stairId: parentId, flightId });
  }
  if (parents.length !== 1) return null;
  const { stairId, flightId } = parents[0];
  if (aggregateCounts.get(stairId) !== 1) return null;
  const stair = reader.entity(stairId)!, flight = reader.entity(flightId)!;
  // The parent must have no competing body; both placements must be rigid.
  if (stair.attributes[6] !== null && stair.attributes[6] !== undefined) return null;
  for (const product of [stair, flight]) {
    const placementId = refId(product.attributes[5]);
    const placement = placementId === null ? null : reader.entity(placementId);
    const axisId = placement ? refId(placement.attributes[1]) : null;
    if (placement?.type.toUpperCase() !== 'IFCLOCALPLACEMENT' || axisId === null || !axis3d(reader, axisId)) return null;
  }
  const flightPlacement = reader.entity(refId(flight.attributes[5])!)!;
  if (refId(flightPlacement.attributes[0]) !== refId(stair.attributes[5])) return null;
  const attribute = (name: string) => flight.attributes[flight.names.indexOf(name)];
  const n = number(attribute(store.schemaVersion === 'IFC2X3' ? 'NumberOfRiser' : 'NumberOfRisers'));
  const r = number(attribute('RiserHeight')), t = number(attribute('TreadLength'));
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 4998 || attribute('NumberOfTreads') !== n
    || typeof r !== 'number' || !Number.isFinite(r) || r <= 0
    || typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return null;
  const shapeId = refId(flight.attributes[6]), shape = shapeId === null ? null : reader.entity(shapeId);
  const reps = shape?.attributes[2];
  if (shape?.type.toUpperCase() !== 'IFCPRODUCTDEFINITIONSHAPE' || !Array.isArray(reps) || reps.length !== 1) return null;
  const repId = refId(reps[0]), rep = repId === null ? null : reader.entity(repId);
  const contextId = rep ? refId(rep.attributes[0]) : null;
  const items = rep?.attributes[3];
  if (rep?.type.toUpperCase() !== 'IFCSHAPEREPRESENTATION' || rep.attributes[1] !== 'Body'
    || rep.attributes[2] !== 'SweptSolid' || contextId === null || contextDimension(reader, contextId) !== 3
    || !Array.isArray(items) || items.length !== 1) return null;
  const solidId = refId(items[0]), solid = solidId === null ? null : reader.entity(solidId);
  if (solid?.type.toUpperCase() !== 'IFCEXTRUDEDAREASOLID') return null;
  const width = number(solid.attributes[3]);
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return null;
  const frame = axis3d(reader, solid.attributes[1]);
  const extrusion = pointOf(reader, solid.attributes[2], 'IFCDIRECTION');
  if (!frame || !vectorIs(frame.o, [0, width, 0]) || !vectorIs(frame.x, [1, 0, 0])
    || !vectorIs(frame.y, [0, 0, 1]) || !vectorIs(frame.z, [0, -1, 0])
    || !extrusion || !vectorIs(extrusion, [0, 0, 1])) return null;
  const profileId = refId(solid.attributes[0]), profile = profileId === null ? null : reader.entity(profileId);
  if (profile?.type.toUpperCase() !== 'IFCARBITRARYCLOSEDPROFILEDEF' || profile.attributes[0] !== '.AREA.'
    || (profile.attributes[1] !== null && profile.attributes[1] !== undefined && typeof profile.attributes[1] !== 'string')) return null;
  const curveId = refId(profile.attributes[2]), curve = curveId === null ? null : reader.entity(curveId);
  const refs = curve?.attributes[0];
  if (curve?.type.toUpperCase() !== 'IFCPOLYLINE' || !Array.isArray(refs)
    || (refs.length !== 2 * n + 3 && refs.length !== 2 * n + 4)) return null;
  const points = refs.map(v => pointOf(reader, v, 'IFCCARTESIANPOINT', 2));
  if (points.some(p => p === null)) return null;
  const p = points as Vec3[];
  // Only the exact builder outline is editable. The pitch underside encodes
  // waist thickness geometrically; optional native stair attributes do not.
  const waist = refs.length === 2 * n + 4 ? (n * r - p[1][1]) * t / Math.hypot(r, t) : undefined;
  if (waist !== undefined && (!Number.isFinite(waist) || waist <= 0)) return null;
  const outline = stairFlightOutline(n, r, t, waist);
  const closed = [...outline, outline[0]];
  if (p.length !== closed.length || p.some((v, i) => !close(v[0], closed[i][0]) || !close(v[1], closed[i][1]))) return null;
  const scale = safeLengthUnitScale(store.source, store.entityIndex, 'readStairDimensions');
  if (scale === null) return null;
  const dimensions: StairDimensions = {
    stairId, flightId, NumberOfRisers: n, Width: width * scale,
    RiserHeight: r * scale, TreadLength: t * scale,
    ...(waist === undefined ? {} : { WaistThickness: waist * scale }),
  };
  return { dimensions, scale, flight, shape, rep, solidId: solidId!, profileId: profileId!, profile };
}

/** Parent and flight resolve to the same strict, single-flight dimensions. */
export function readStairDimensions(store: IfcDataStore, id: number, view?: MutablePropertyView | null): StairDimensions | null {
  return read(store, new AnchorEntityReader(store, view), id)?.dimensions ?? null;
}

/** Rebuild only the occurrence's canonical stepped body. Placements, the
 * first-riser foot, identities, type/style leaves and source bodies stay held.
 * RiserHeight changes the total rise; TreadLength changes the total run.
 * Atomic refusal for unsupported graphs or dimensions, including late errors. */
export function editStairDimensionsInStore(store: IfcDataStore, editor: StoreEditor, id: number, patch: StairDimensionEdit): StairDimensions {
  return editor.runAtomic(draft => {
    const reader = new AnchorEntityReader(store, draft.getMutationView());
    const current = read(store, reader, id);
    if (!current) throw new Error(`The stair #${id} is not a supported single stepped flight`);
    const fields = ['Width', 'RiserHeight', 'TreadLength', 'WaistThickness'] as const;
    for (const [name, value] of Object.entries(patch)) {
      if (!fields.some(field => field === name)) throw new Error(`Unsupported stair dimension ${name}`);
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
        throw new Error(`${name} must be a finite positive number`);
      }
    }
    const next = { ...current.dimensions };
    for (const field of fields) if (patch[field] !== undefined) next[field] = patch[field];
    assertStairParams({ ...next, Position: [0, 0, 0] }, 'editStairDimensionsInStore');
    const native = (metres: number) => toNativeLength({ lengthUnitScale: current.scale }, metres);
    const body = emitStairFlightBody(draft, next.NumberOfRisers, native(next.RiserHeight), native(next.TreadLength), native(next.Width),
      next.WaistThickness === undefined ? undefined : native(next.WaistThickness));
    // Clone style attachments, retaining their shared style leaves; never
    // repoint an attachment that may also style a different occurrence.
    for (const styleId of reader.ids('IFCSTYLEDITEM')) {
      const style = reader.entity(styleId)!;
      const item = refId(style.attributes[0]);
      const target = item === current.solidId ? body.solidId : item === current.profileId ? body.profileId : null;
      if (target === null) continue;
      const styles = style.attributes[1];
      if (!Array.isArray(styles) || styles.length === 0 || styles.some(v => refId(v) === null)) throw new Error('Unreadable stair style attachment');
      const name = style.attributes[2];
      if (name !== null && name !== undefined && typeof name !== 'string') throw new Error('Unreadable stair style name');
      draft.addEntity('IfcStyledItem', [ref(target), styles.map(v => ref(refId(v)!)), name ?? null]);
    }
    draft.setPositionalAttribute(body.profileId, 1, current.profile.attributes[1] as string | null);
    const rep = draft.addEntity('IfcShapeRepresentation', [
      ref(refId(current.rep.attributes[0])!), current.rep.attributes[1] as string,
      current.rep.attributes[2] as string, [ref(body.solidId)],
    ]).expressId;
    const labels = current.shape.attributes.slice(0, 2).map(v => {
      if (v !== null && v !== undefined && typeof v !== 'string') throw new Error('Unreadable stair shape label');
      return v ?? null;
    });
    const shape = draft.addEntity('IfcProductDefinitionShape', [...labels, [ref(rep)]]).expressId;
    draft.setPositionalAttribute(next.flightId, 6, ref(shape));
    for (const name of ['RiserHeight', 'TreadLength'] as const) {
      draft.setPositionalAttribute(next.flightId, current.flight.names.indexOf(name), { real: native(next[name]) });
    }
    const updated = readStairDimensions(store, next.flightId, draft.getMutationView());
    if (!updated) throw new Error('The stair edit cannot reproduce its validated flight; all writes were rolled back');
    return updated;
  });
}
