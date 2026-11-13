/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { effectiveReferencers } from '@ifc-lite/export';
import type { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { SpatialAnchor } from './anchor.js';
import { productGuid } from './_emit-helpers.js';
import { refId } from './host-geometry-frame.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { signedArea, type FootprintRoofPlan } from './roof-footprint-plan.js';

export const PART_TYPE = 'IfcLite_RoofPlane';
export const RELATION_NAME = 'Footprint roof planes';
type MeasureAnchor = Pick<SpatialAnchor, 'lengthUnitScale' | 'getMeasureUnitScales' | 'guidRandom'>;

/** Validate before emitting a roof; other builders need not resolve unrelated measure units. */
export function roofMeasureScales(anchor: MeasureAnchor) {
  const units = anchor.getMeasureUnitScales?.();
  const result = { length: anchor.lengthUnitScale ?? 1, area: units?.areaUnitScale ?? 1,
    volume: units?.volumeUnitScale ?? 1, angle: units?.planeAngleUnitScale ?? 1 };
  for (const scale of Object.values(result)) {
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Roof measurement units must have positive finite scales');
  }
  return result;
}

/** Quantitative plane parts are assigned to the roof; its own Body remains the geometry source.
 * IFC2X3 IfcRoof.WR1 forbids a Body together with decomposition. Using the same
 * IfcRelAssignsToProduct in every schema also keeps cross-schema exports valid. */
export function getFootprintRoofPlaneParts(store: IfcDataStore, view: MutablePropertyView, roofId: number): number[] {
  const reader = new AnchorEntityReader(store, view);
  return reader.entity(roofId)?.type.toUpperCase() === 'IFCROOF' ? partAssignment(reader, roofId)?.parts ?? [] : [];
}
function partAssignment(reader: AnchorEntityReader, roofId: number): { id: number; parts: number[] } | null {
  for (const id of reader.ids('IFCRELASSIGNSTOPRODUCT')) {
    const a = reader.entity(id)?.attributes;
    if (!a || a[2] !== RELATION_NAME || refId(a[6]) !== roofId || !Array.isArray(a[4])) continue;
    const parts = a[4].map(refId).filter((id): id is number => id !== null);
    if (parts.some(id => {
      const part = reader.entity(id);
      return part?.type.toUpperCase() !== 'IFCSLAB' || part.attributes[4] !== PART_TYPE;
    })) throw new Error('The roof plane assignment contains an unmanaged part');
    return { id, parts };
  }
  return null;
}

const OWNED_RECORDS = new Set(['IFCSLAB', 'IFCPROPERTYSET', 'IFCPROPERTYSINGLEVALUE', 'IFCPROPERTYLISTVALUE',
  'IFCPROPERTYENUMERATEDVALUE', 'IFCCOMPLEXPROPERTY', 'IFCELEMENTQUANTITY', 'IFCPHYSICALCOMPLEXQUANTITY',
  'IFCQUANTITYLENGTH', 'IFCQUANTITYAREA', 'IFCQUANTITYVOLUME', 'IFCQUANTITYCOUNT', 'IFCQUANTITYWEIGHT',
  'IFCQUANTITYTIME', 'IFCLOCALPLACEMENT', 'IFCAXIS2PLACEMENT3D', 'IFCCARTESIANPOINT', 'IFCDIRECTION']);

/** Remove a vanished plane and its exclusively-owned metadata; preserve shared units and definitions. */
function removePart(store: IfcDataStore, editor: StoreEditor, partId: number): void {
  const view = editor.getMutationView(), reader = new AnchorEntityReader(store, view);
  const refs = effectiveReferencers(store, view);
  const roots = [partId];
  for (const parent of refs(partId)) {
    const record = reader.entity(parent);
    if (!record) continue;
    const type = record.type.toUpperCase(), a = record.attributes;
    const related = a[4];
    if (!(type.startsWith('IFCRELASSIGNS') || type.startsWith('IFCRELASSOCIATES') || type.startsWith('IFCRELDEFINES'))
      || !Array.isArray(related) || related.some(ref => refId(ref) === null) || !related.some(ref => refId(ref) === partId)) {
      throw new Error(`Cannot remove roof plane #${partId}: it is referenced by ${record.type} #${parent}`);
    }
    const remaining = related.filter(ref => refId(ref) !== partId);
    if (remaining.length) editor.setPositionalAttribute(parent, 4, remaining.map(ref => `#${refId(ref)}`));
    else {
      editor.removeEntity(parent);
      if (type === 'IFCRELDEFINESBYPROPERTIES') {
        const set = refId(a[5]);
        if (set !== null) roots.push(set);
      }
    }
  }
  const found = new Set<number>(), stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (found.has(id)) continue;
    const row = reader.entity(id), type = row?.type.toUpperCase();
    if (!row || !type || !OWNED_RECORDS.has(type)) continue;
    found.add(id);
    if (found.size > 10_000) throw new Error('Roof plane metadata exceeds the cleanup work budget');
    // PlacementRelTo is an ancestor, never owned by this plane.
    const values: unknown[] = type === 'IFCLOCALPLACEMENT' ? [row.attributes[1]] : [...row.attributes];
    const arrays = new Set<unknown[]>();
    while (values.length) {
      const value = values.pop();
      if (Array.isArray(value)) {
        if (!arrays.has(value)) { arrays.add(value); values.push(...value); }
      } else {
        const child = refId(value);
        if (child !== null) stack.push(child);
      }
    }
  }
  const remainingRefs = effectiveReferencers(store, view);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of found) if (remainingRefs(id).some(parent => !found.has(parent))) { found.delete(id); changed = true; }
  }
  for (const id of found) editor.removeEntity(id);
}

/** Update standard plane quantities and pitch atomically with the caller's roof body edit.
 * Parts have no duplicate Representation. Their Tag is the defining footprint edge
 * (-1 for a flat roof); unchanged edges retain identity and user properties. */
export function writeRoofPlaneParts(editor: StoreEditor, anchor: MeasureAnchor, roofId: number,
  plan: FootprintRoofPlan, thickness: number, store?: IfcDataStore): void {
  const view = editor.getMutationView(), reader = new AnchorEntityReader(store ?? null, view);
  const roof = reader.entity(roofId);
  if (!roof || roof.type.toUpperCase() !== 'IFCROOF') throw new Error('Plane measurements need an IfcRoof');
  const ownerId = refId(roof.attributes[1]);
  const owner = ownerId === null ? null : `#${ownerId}`;
  const previous = partAssignment(reader, roofId);
  const byEdge = new Map<number, number>();
  for (const id of previous?.parts ?? []) {
    const edge = Number(reader.entity(id)?.attributes[7]);
    if (!Number.isInteger(edge) || byEdge.has(edge)) throw new Error('Ambiguous managed roof plane edge');
    byEdge.set(edge, id);
  }
  const { length, area: areaScale, volume: volumeScale, angle: angleScale } = roofMeasureScales(anchor);
  let hasOpenings = false;
  for (const id of reader.ids('IFCRELVOIDSELEMENT')) {
    if (refId(reader.entity(id)?.attributes[4]) === roofId) { hasOpenings = true; break; }
  }
  const planes = plan.planes.length ? plan.planes : [{ edge: -1, slope: 0, outline: plan.eaves }];
  const ids: number[] = [];
  let totalArea = 0;
  const clean = (value: number) => Number(value.toPrecision(12));
  for (const plane of planes) {
    let id = byEdge.get(plane.edge);
    if (id === undefined) {
      id = editor.addEntity('IfcSlab', [productGuid({}, anchor.guidRandom), owner,
        `Roof plane ${plane.edge + 1}`, 'Geometry is carried by the assigned roof.', PART_TYPE,
        null, null, String(plane.edge), '.ROOF.']).expressId;
    }
    ids.push(id);
    const area = Math.abs(signedArea(plane.outline)) * length ** 2 / Math.cos(plane.slope);
    totalArea += area;
    view.setQuantity(id, 'Qto_SlabBaseQuantities', 'GrossArea', clean(area / areaScale), QuantityType.Area);
    view.setQuantity(id, 'Qto_SlabBaseQuantities', 'GrossVolume', clean(area * thickness / volumeScale), QuantityType.Volume);
    if (hasOpenings) {
      view.deleteQuantity(id, 'Qto_SlabBaseQuantities', 'NetArea');
      view.deleteQuantity(id, 'Qto_SlabBaseQuantities', 'NetVolume');
    } else {
      view.setQuantity(id, 'Qto_SlabBaseQuantities', 'NetArea', clean(area / areaScale), QuantityType.Area);
      view.setQuantity(id, 'Qto_SlabBaseQuantities', 'NetVolume', clean(area * thickness / volumeScale), QuantityType.Volume);
    }
    view.setProperty(id, 'Pset_SlabCommon', 'PitchAngle', plane.slope / angleScale,
      PropertyValueType.Real, undefined, false, 'IfcPlaneAngleMeasure');
  }
  if (previous) editor.setPositionalAttribute(previous.id, 4, ids.map(id => `#${id}`));
  else editor.addEntity('IfcRelAssignsToProduct', [productGuid({}, anchor.guidRandom), owner,
    RELATION_NAME, null, ids.map(id => `#${id}`), null, `#${roofId}`]);
  if (store) for (const id of previous?.parts ?? []) if (!ids.includes(id)) removePart(store, editor, id);
  view.setQuantity(roofId, 'Qto_RoofBaseQuantities', 'GrossArea', clean(totalArea / areaScale), QuantityType.Area);
  if (hasOpenings) view.deleteQuantity(roofId, 'Qto_RoofBaseQuantities', 'NetArea');
  else view.setQuantity(roofId, 'Qto_RoofBaseQuantities', 'NetArea', clean(totalArea / areaScale), QuantityType.Area);
  view.setQuantity(roofId, 'Qto_RoofBaseQuantities', 'ProjectedArea', clean(Math.abs(signedArea(plan.eaves)) * length ** 2 / areaScale), QuantityType.Area);
}
