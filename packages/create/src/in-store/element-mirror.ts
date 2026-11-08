/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { expandAffectedSet, editOwnershipRefusal, effectiveReferencers } from '@ifc-lite/export';
import { copyBatchInStore } from './copy-batch.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { planElementTransform } from './element-transform-plan.js';
import { readWallJoinRels } from './wall-join-read.js';
import { effectiveStoreyId } from './edit/effective-storey.js';
import { objectPlacementOf, uprightFrame, unrotateBy, rotateBy } from './element-transform-frames.js';
import { axis3d, refId } from './host-geometry-frame.js';
import { liveEntityConforms } from './resolve-relations.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';

export interface MirrorElementsParams {
  /** Two distinct storey-local IFC XY points in metres. */
  axis: readonly [readonly [number, number], readonly [number, number]];
  copy?: boolean;
}

/** Reflect placements and each product's local geometry. A proper upright
 * placement retains +Z; the local mapped representation carries the negative
 * determinant. Hosted cuts and fillings retain their original relationships. */
export function mirrorElementsInStore(store: IfcDataStore, editor: StoreEditor, ids: readonly number[], params: MirrorElementsParams): number[] {
  const [a, b] = params.axis;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (![...a, ...b].every(Number.isFinite) || !(length > 1e-9)) throw new Error('Mirror requires two finite distinct axis points');
  if (!ids.length || ids.length > 10000) throw new Error('Mirror requires 1..10000 products');
  const u = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const vector = (p: readonly [number, number]): [number, number] => {
    const dot = p[0] * u[0] + p[1] * u[1];
    return [2 * dot * u[0] - p[0], 2 * dot * u[1] - p[1]];
  };
  return editor.runAtomic(draft => {
    const selected = params.copy ? copyBatchInStore(store, draft, ids, [{}]).map(r => r.copyId) : [...new Set(ids)];
    const view = draft.getMutationView(), reader = new AnchorEntityReader(store, view);
    const plan = planElementTransform({ dataStore: store, view, selected, storeyOf: id => effectiveStoreyId(store, view, id) ?? null });
    if (plan.refused.length) throw new Error('Mirror requires local placements under a storey');
    const products = new Set(expandAffectedSet(store, view, selected, 'hostsChanged'));
    const roots = new Map(plan.roots.map(r => [r.expressId, r]));
    const placements = new Set<number>();
    const references = effectiveReferencers(store, view);
    for (const id of products) {
      if (!liveEntityConforms(store, id, 'IfcProduct', view)) continue;
      const placementId = objectPlacementOf({ dataStore: store, view }, id);
      if (placementId !== null) {
        if (placements.has(placementId)) throw new Error('Mirror selection shares a local placement');
        placements.add(placementId);
      }
      const shapeId = refId(reader.entity(id)?.attributes[6]);
      if (shapeId !== null && references(shapeId).some(ref => reader.entity(ref)?.type.toUpperCase() === 'IFCSHAPEASPECT')) {
        throw new Error('Mirror does not support products with shape aspects');
      }
    }
    for (const join of readWallJoinRels(store, view)) {
      if (products.has(join.relatingId) !== products.has(join.relatedId)) {
        throw new Error('Mirror requires both sides of a wall join to be selected');
      }
    }
    const unit = getModelLengthUnitScale(store);
    const emit = (type: string, attrs: Parameters<StoreEditor['addEntity']>[1]) => `#${draft.addEntity(type, attrs).expressId}`;
    const point = (p: readonly number[]) => emit('IfcCartesianPoint', [[...p]]);
    const dir = (p: readonly number[]) => emit('IfcDirection', [[...p]]);
    const identity = () => emit('IfcAxis2Placement3D', [point([0, 0, 0]), null, null]);
    for (const id of products) {
      const product = reader.entity(id);
      const placementId = objectPlacementOf({ dataStore: store, view }, id);
      if (!product || !liveEntityConforms(store, id, 'IfcProduct', view) || placementId === null) continue;
      const placement = reader.entity(placementId);
      const local = axis3d(reader, placement?.attributes[1]);
      if (!local) throw new Error(`Mirror requires readable local placements (#${id})`);
      const ownership = editOwnershipRefusal(store, view, [placementId], products);
      if (ownership) throw new Error(ownership);
      const root = roots.get(id);
      let origin: [number, number], x: [number, number, number], z: [number, number, number];
      if (root) {
        const frame = uprightFrame({ dataStore: store, view }, placementId);
        if (!frame) throw new Error('Mirror roots must be upright');
        const d = vector([root.origin[0] - a[0], root.origin[1] - a[1]]);
        origin = unrotateBy(root.parent.axis, [a[0] + d[0] - root.parent.origin[0], a[1] + d[1] - root.parent.origin[1]]);
        const axis = unrotateBy(root.parent.axis, vector(rotateBy(root.parent.axis, frame.axis)));
        x = [...axis, 0];
        z = [0, 0, 1];
      } else {
        const parent = refId(placement?.attributes[0]);
        if (parent === null || !placements.has(parent)) throw new Error('Mirror requires hosted placements directly under a mirrored product');
        origin = [local.o[0] * unit, -local.o[1] * unit];
        x = [local.x[0], -local.x[1], local.x[2]];
        z = [local.z[0], -local.z[1], local.z[2]];
      }
      if (![...origin, ...x, ...z].every(Number.isFinite)) throw new Error('Mirror coordinate overflow');
      const newAxis = emit('IfcAxis2Placement3D', [point([origin[0] / unit, origin[1] / unit, local.o[2]]), dir(z), dir(x)]);
      draft.setPositionalAttribute(placementId, 1, newAxis);
      const shapeId = refId(product.attributes[6]);
      const shape = shapeId === null ? null : reader.entity(shapeId);
      if (shape && Array.isArray(shape.attributes[2])) {
        const reps = shape.attributes[2].map(ref => {
          const rep = reader.entity(refId(ref) ?? -1);
          if (!rep) throw new Error('Mirror representation is unreadable');
          if (!Array.isArray(rep.attributes[3])) throw new Error('Mirror representation has no items');
          const mappedRep = emit('IfcShapeRepresentation', [`#${refId(rep.attributes[0])}`, rep.attributes[1] as string, rep.attributes[2] as string, rep.attributes[3].map(item => `#${refId(item)}`)]);
          const map = emit('IfcRepresentationMap', [identity(), mappedRep]);
          const transform = emit('IfcCartesianTransformationOperator3D', [dir([1, 0, 0]), dir([0, -1, 0]), point([0, 0, 0]), { real: 1 }, dir([0, 0, 1])]);
          const item = emit('IfcMappedItem', [map, transform]);
          return emit('IfcShapeRepresentation', [`#${refId(rep.attributes[0])}`, rep.attributes[1] as string, 'MappedRepresentation', [item]]);
        });
        draft.setPositionalAttribute(id, 6, emit('IfcProductDefinitionShape', [null, null, reps]));
        // IfcProductDefinitionShape.ShapeOfProduct is mandatory, and a shape
        // representation belongs to exactly one product representation OR map.
        // Retain shared source shapes; retire only now-unreferenced owners.
        if (shapeId !== null && effectiveReferencers(store, view)(shapeId).length === 0) {
          draft.removeEntity(shapeId);
          const remainingReferences = effectiveReferencers(store, view);
          for (const old of shape.attributes[2]) {
            const oldId = refId(old);
            if (oldId !== null && remainingReferences(oldId).length === 0) draft.removeEntity(oldId);
          }
        }
      }
      if (liveEntityConforms(store, id, 'IfcDoor', view)) {
        const slot = product.names.indexOf('OperationType');
        const operation = product.attributes[slot];
        if (slot >= 0 && typeof operation === 'string') {
          const token = operation.replace(/^\./, '').replace(/\.$/, '');
          const flipped = token.replace(/LEFT|RIGHT/g, side => side === 'LEFT' ? 'RIGHT' : 'LEFT');
          if (flipped !== token) draft.setPositionalAttribute(id, slot, `.${flipped}.`);
        }
      }
    }
    return selected;
  });
}
