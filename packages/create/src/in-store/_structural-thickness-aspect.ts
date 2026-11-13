/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { structuralReferenceAttributes } from './_structural-reference.js';
import { asRef } from './style-entity-reader.js';

/** Copy the aspect and its exclusive representations; point resources stay borrowed. */
export function prepareThicknessAspect(editor: StoreEditor, id: number, count: number, store?: IfcDataStore) {
  const label = 'addStructuralSurfaceMemberToStore: VaryingThicknessLocation';
  const aspect = structuralReferenceAttributes(editor, id, store);
  const reps = aspect[0];
  if (!Array.isArray(reps) || reps.length !== count) throw new Error(`${label} needs one representation per thickness value`);
  const optionalText = (value: unknown) => {
    if (value == null) return null;
    if (typeof value !== 'string') throw new Error(`${label} has an invalid label`);
    return value;
  };
  const name = optionalText(aspect[1]), description = optionalText(aspect[2]);
  const logical = aspect[3];
  if (typeof logical !== 'boolean' && !(typeof logical === 'string' && ['.T.', '.F.', '.U.'].includes(logical))) throw new Error(`${label} needs a logical ProductDefinitional value`);
  const productDefinitional = typeof logical === 'boolean' ? logical : String(logical);
  // Resolve and validate every borrowed record before emitting any owned geometry.
  const plans = reps.map(ref => {
    const repId = asRef(ref);
    if (repId === null || editor.getEntityType(repId) !== 'IfcShapeRepresentation') throw new Error(`${label} needs point shape representations`);
    const attrs = structuralReferenceAttributes(editor, repId, store);
    const context = asRef(attrs[0]);
    const items = attrs[3];
    const point = Array.isArray(items) && items.length === 1 ? asRef(items[0]) : null;
    if (context === null || !['IfcGeometricRepresentationContext', 'IfcGeometricRepresentationSubContext'].includes(editor.getEntityType(context) ?? '') || point === null || !['IfcCartesianPoint', 'IfcPointOnSurface'].includes(editor.getEntityType(point) ?? '')) throw new Error(`${label} needs one Cartesian point or point on surface per representation`);
    return { context, identifier: optionalText(attrs[1]), point };
  });
  return (productShapeId: number) => {
    const representations = plans.map(({ context, identifier, point }) =>
      `#${editor.addEntity('IfcShapeRepresentation', [`#${context}`, identifier, 'Point', [`#${point}`]]).expressId}`);
    return editor.addEntity('IfcShapeAspect', [representations, name, description, productDefinitional, `#${productShapeId}`]).expressId;
  };
}
