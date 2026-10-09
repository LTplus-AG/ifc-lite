/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { effectiveStoreyId } from '../../../../../packages/create/src/in-store/edit/effective-storey';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { effectiveStoreyIds, planStoreyReassignment, reassignElementsToStoreyInStore, type StoreyReassignmentPlan } from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { ExistingElement, StoreyTarget } from './model-authoring';
import { record, parseGlobalIdTarget } from './model-authoring-fields';

export interface StoreyReassignmentOp {
  op: 'element.reassignStorey'; target: ExistingElement;
  sourceStorey: StoreyTarget; destinationStorey: StoreyTarget;
  expected: StoreyReassignmentPlan;
}

/** Expected pins are verbatim native fields, independent of the batch units.
 * Bound untrusted nesting/work before accepting a complete current pin. */
function parseExpected(value: unknown, at: string): StoreyReassignmentPlan {
  let work = 0;
  const finite = (item: unknown, depth: number): boolean => {
    if (++work > 200_000 || depth > 12) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.length <= 5_000 && item.every(child => finite(child, depth + 1));
    return record(item) && Object.keys(item).length <= 30 && Object.values(item).every(child => finite(child, depth + 1));
  };
  const id = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item > 0;
  const frame = (item: unknown) => record(item) && ['o', 'x', 'y', 'z'].every(key => Array.isArray(item[key])
    && item[key].length === 3 && item[key].every((n: unknown) => typeof n === 'number' && Number.isFinite(n)));
  const relationship = (item: unknown) => record(item) && id(item.id) && typeof item.type === 'string' && id(item.parent)
    && Array.isArray(item.children) && item.children.length > 0 && item.children.every(id)
    && Number.isInteger(item.listIndex) && Number.isInteger(item.parentIndex);
  if (!record(value) || !finite(value, 0) || !id(value.sourceStoreyId) || !id(value.destinationStoreyId) || !id(value.destinationPlacementId)
    || !Array.isArray(value.products) || !value.products.length || !value.products.every(product => record(product) && id(product.expressId)
      && typeof product.GlobalId === 'string' && typeof product.type === 'string' && Array.isArray(product.attributes) && id(product.placementId) && frame(product.world))
    || !Array.isArray(value.placements) || !value.placements.length || !value.placements.every(placement => record(placement) && id(placement.expressId) && frame(placement.relative))
    || !Array.isArray(value.relationships) || !value.relationships.every(relationship)
    || !Array.isArray(value.sourceMemberships) || !value.sourceMemberships.length || !value.sourceMemberships.every(relationship)) {
    throw new Error(`${at}: copy the complete nativeStoreyReassignments expected pin; missing or projected state cannot authorize a move`);
  }
  const pin = value as unknown as StoreyReassignmentPlan;
  const frameOf = (f: StoreyReassignmentPlan['products'][number]['world']) => ({ o: f.o, x: f.x, y: f.y, z: f.z });
  const relationOf = (r: StoreyReassignmentPlan['relationships'][number]) => ({ id: r.id, type: r.type, parent: r.parent, children: r.children, listIndex: r.listIndex, parentIndex: r.parentIndex });
  return { sourceStoreyId: pin.sourceStoreyId, destinationStoreyId: pin.destinationStoreyId, destinationPlacementId: pin.destinationPlacementId,
    products: pin.products.map(p => ({ expressId: p.expressId, GlobalId: p.GlobalId, type: p.type, attributes: p.attributes, placementId: p.placementId, world: frameOf(p.world) })),
    placements: pin.placements.map(p => ({ expressId: p.expressId, relative: frameOf(p.relative) })),
    relationships: pin.relationships.map(relationOf), sourceMemberships: pin.sourceMemberships.map(relationOf) };
}

export function parseStoreyReassignment(value: Record<string, unknown>, target: ExistingElement, at: string): StoreyReassignmentOp {
  if (Object.keys(value).some(key => !['op', 'target', 'sourceStorey', 'destinationStorey', 'expected'].includes(key))) throw new Error(`${at}: unsupported reassignment field`);
  const sourceStorey = parseGlobalIdTarget(value.sourceStorey, `${at} sourceStorey`);
  const destinationStorey = parseGlobalIdTarget(value.destinationStorey, `${at} destinationStorey`);
  if (!target.modelId || sourceStorey.modelId !== target.modelId || destinationStorey.modelId !== target.modelId) throw new Error(`${at}: declare the same owning modelId for product and both storeys`);
  return { op: 'element.reassignStorey', target, sourceStorey, destinationStorey, expected: parseExpected(value.expected, `${at} expected`) };
}

export function writeReviewedStoreyReassignment(store: IfcDataStore, editor: StoreEditor, op: StoreyReassignmentOp, product: number, source: number, destination: number) {
  return reassignElementsToStoreyInStore(store, editor, [product], source, destination, op.expected);
}

/** Rich evidence and explicit attachments use the same complete admission.
 * Large spatial inventories disclose unavailability instead of partial pins. */
export function nativeStoreyReassignmentEvidence(target: ModelEditTarget | null, expressId: number) {
  if (!target) return null;
  const { dataStore, view } = target;
  const source = effectiveStoreyId(dataStore, view, expressId);
  const storeys = effectiveStoreyIds(dataStore, view);
  if (source === undefined || storeys.length > 20) return null;
  const results: { sourceStorey: StoreyTarget; destinationStorey: StoreyTarget; expectedJsonParts: string[]; productCount: number }[] = [];
  for (const from of [source]) for (const to of storeys) {
    if (from === to) continue;
    try {
      const expected = planStoreyReassignment(dataStore, view, [expressId], from, to);
      const sourceGuid = effectiveMetadataRecord(dataStore, from, view)?.attributes[0];
      const destinationGuid = effectiveMetadataRecord(dataStore, to, view)?.attributes[0];
      if (typeof sourceGuid !== 'string' || typeof destinationGuid !== 'string') continue;
      const json = JSON.stringify(expected), expectedJsonParts = Array.from({ length: Math.ceil(json.length / 1000) }, (_, i) => json.slice(i * 1000, (i + 1) * 1000));
      results.push({ sourceStorey: { modelId: target.modelId, globalId: sourceGuid }, destinationStorey: { modelId: target.modelId, globalId: destinationGuid }, expectedJsonParts, productCount: expected.products.length });
    } catch (error) { if (!(error instanceof Error)) throw error; }
  }
  return results.length ? results : null;
}


/** Reuse the viewer's canonical GlobalId resolution and model-join gate. */
export function resolveReviewedStoreyReassignment(op: StoreyReassignmentOp,
  existing: (target: ExistingElement) => number,
  locate: (target: StoreyTarget) => { modelId: string; expressId: number }, join: (modelId: string) => void) {
  const target = existing(op.target), source = locate(op.sourceStorey), destination = locate(op.destinationStorey);
  join(source.modelId); join(destination.modelId);
  return { target, reassignment: { source: source.expressId, destination: destination.expressId } };
}
