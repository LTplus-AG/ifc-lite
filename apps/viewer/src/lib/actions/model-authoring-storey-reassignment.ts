/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { effectiveStoreyId } from '../../../../../packages/create/src/in-store/edit/effective-storey';
import { effectiveStoreyIds, planStoreyReassignmentCandidates, reassignElementsToStoreyInStore, type StoreyReassignmentPlan } from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { ExistingElement, StoreyTarget } from './model-authoring';
import { record, parseGlobalIdTarget, MODEL_AUTHORING_TEXT_LIMIT } from './model-authoring-fields';

export interface StoreyReassignmentOp {
  op: 'element.reassignStorey'; target: ExistingElement;
  sourceStorey: StoreyTarget; destinationStorey: StoreyTarget;
  expected: StoreyReassignmentPlan;
}

export type StoreyPinRefusal = 'unavailable-native-pin-work-budget' | 'unavailable-native-pin-depth-budget' | 'unavailable-native-pin-shape' | 'unavailable-native-pin-text-budget';

/** One iterative bounded admission for source-owned producer and JSON consumer. */
function expectedPinRefusal(value: unknown): StoreyPinRefusal | null {
  const pending = [{ value, depth: 0 }]; let work = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++work > 200_000) return 'unavailable-native-pin-work-budget';
    if (item.depth > 12) return 'unavailable-native-pin-depth-budget';
    if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'number') { if (!Number.isFinite(item.value)) return 'unavailable-native-pin-shape'; continue; }
    if (!Array.isArray(item.value) && !record(item.value)) return 'unavailable-native-pin-shape';
    const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
    if (children.length > (Array.isArray(item.value) ? 200_000 : 30)) return 'unavailable-native-pin-work-budget';
    if (work + pending.length + children.length > 200_000) return 'unavailable-native-pin-work-budget';
    for (let i = children.length - 1; i >= 0; i--) pending.push({ value: children[i], depth: item.depth + 1 });
  }
  const id = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item > 0;
  const storey = (item: unknown, expressId: unknown) => record(item) && item.expressId === expressId && id(item.expressId)
    && typeof item.GlobalId === 'string' && /^[0-3][0-9A-Za-z_$]{21}$/.test(item.GlobalId);
  const frame = (item: unknown) => record(item) && ['o', 'x', 'y', 'z'].every(key => Array.isArray(item[key])
    && item[key].length === 3 && item[key].every((n: unknown) => typeof n === 'number' && Number.isFinite(n)));
  const relationship = (item: unknown) => record(item) && id(item.id) && typeof item.type === 'string' && id(item.parent)
    && Array.isArray(item.attributes) && Array.isArray(item.children) && item.children.length > 0 && item.children.every(id)
    && Number.isInteger(item.listIndex) && Number.isInteger(item.parentIndex);
  if (!record(value) || !id(value.sourceStoreyId) || !id(value.destinationStoreyId) || !id(value.destinationPlacementId)
    || !storey(value.sourceStorey, value.sourceStoreyId) || !storey(value.destinationStorey, value.destinationStoreyId)
    || !Array.isArray(value.products) || !value.products.length || value.products.length > 5_000 || !value.products.every(product => record(product) && id(product.expressId)
      && typeof product.GlobalId === 'string' && typeof product.type === 'string' && Array.isArray(product.attributes) && id(product.placementId) && frame(product.world))
    || !Array.isArray(value.placements) || !value.placements.length || !value.placements.every(placement => record(placement) && id(placement.expressId) && frame(placement.relative))
    || !Array.isArray(value.relationships) || !value.relationships.every(relationship)
    || !Array.isArray(value.sourceMemberships) || !value.sourceMemberships.length || !value.sourceMemberships.every(relationship)) {
    return 'unavailable-native-pin-shape';
  }
  if (JSON.stringify(value).length > MODEL_AUTHORING_TEXT_LIMIT) return 'unavailable-native-pin-text-budget';
  return null;
}

/** Expected pins are verbatim native fields, independent of the batch units.
 * Bound untrusted nesting/work before accepting a complete current pin. */
function parseExpected(value: unknown, at: string): StoreyReassignmentPlan {
  const refusal = expectedPinRefusal(value);
  if (refusal) throw new Error(`${at}: ${refusal}; copy the complete nativeStoreyReassignments expected pin`);
  const pin = value as unknown as StoreyReassignmentPlan;
  const frameOf = (f: StoreyReassignmentPlan['products'][number]['world']) => ({ o: f.o, x: f.x, y: f.y, z: f.z });
  const relationOf = (r: StoreyReassignmentPlan['relationships'][number]) => ({ id: r.id, type: r.type, parent: r.parent, children: r.children, listIndex: r.listIndex, parentIndex: r.parentIndex, attributes: r.attributes });
  return { sourceStorey: { expressId: pin.sourceStorey.expressId, GlobalId: pin.sourceStorey.GlobalId },
    destinationStorey: { expressId: pin.destinationStorey.expressId, GlobalId: pin.destinationStorey.GlobalId },
    sourceStoreyId: pin.sourceStoreyId, destinationStoreyId: pin.destinationStoreyId, destinationPlacementId: pin.destinationPlacementId,
    products: pin.products.map(p => ({ expressId: p.expressId, GlobalId: p.GlobalId, type: p.type, attributes: p.attributes, placementId: p.placementId, world: frameOf(p.world) })),
    placements: pin.placements.map(p => ({ expressId: p.expressId, relative: frameOf(p.relative) })),
    relationships: pin.relationships.map(relationOf), sourceMemberships: pin.sourceMemberships.map(relationOf) };
}

/** Measure the minimal complete one-operation batch with a nonempty title.
 * Extra rationale, titles and other operations remain subject to the outer parser. */
function completeBatchRefusal(operation: StoreyReassignmentOp): StoreyPinRefusal | null {
  return JSON.stringify({ kind: 'model.authoring', version: 1, title: 'N',
    units: 'm', frame: 'storey-local', operations: [operation] }).length > MODEL_AUTHORING_TEXT_LIMIT
    ? 'unavailable-native-pin-text-budget' : null;
}

export function parseStoreyReassignment(value: Record<string, unknown>, target: ExistingElement, at: string): StoreyReassignmentOp {
  if (Object.keys(value).some(key => !['op', 'target', 'sourceStorey', 'destinationStorey', 'expected'].includes(key))) throw new Error(`${at}: unsupported reassignment field`);
  const sourceStorey = parseGlobalIdTarget(value.sourceStorey, `${at} sourceStorey`);
  const destinationStorey = parseGlobalIdTarget(value.destinationStorey, `${at} destinationStorey`);
  if (!target.modelId || sourceStorey.modelId !== target.modelId || destinationStorey.modelId !== target.modelId) throw new Error(`${at}: declare the same owning modelId for product and both storeys`);
  const operation: StoreyReassignmentOp = { op: 'element.reassignStorey', target, sourceStorey, destinationStorey, expected: parseExpected(value.expected, `${at} expected`) };
  return operation;
}

export function writeReviewedStoreyReassignment(store: IfcDataStore, editor: StoreEditor, op: StoreyReassignmentOp, product: number, source: number, destination: number) {
  return reassignElementsToStoreyInStore(store, editor, [product], source, destination, op.expected);
}

/** Rich evidence and explicit attachments use the same complete admission.
 * Large spatial inventories disclose unavailability instead of partial pins. */
export function nativeStoreyReassignmentEvidence(target: ModelEditTarget | null, expressId: number, onRefusal?: (reason: StoreyPinRefusal) => void) {
  if (!target) return null;
  const { dataStore, view } = target;
  const source = effectiveStoreyId(dataStore, view, expressId);
  const storeys = effectiveStoreyIds(dataStore, view);
  if (source === undefined || storeys.length > 20) return null;
  const results: { sourceStorey: StoreyTarget; destinationStorey: StoreyTarget; expectedJsonParts: string[]; productCount: number }[] = [];
  try {
    const candidates = planStoreyReassignmentCandidates(dataStore, view, [expressId], source, storeys.filter(id => id !== source));
    for (const { plan: expected } of candidates) {
      if (!expected) continue;
      const refusal = expectedPinRefusal(expected);
      if (refusal) { onRefusal?.(refusal); continue; }
      const sourceStorey = { modelId: target.modelId, globalId: expected.sourceStorey.GlobalId };
      const destinationStorey = { modelId: target.modelId, globalId: expected.destinationStorey.GlobalId };
      const product = expected.products.find(item => item.expressId === expressId);
      if (!product) continue;
      const operation: StoreyReassignmentOp = { op: 'element.reassignStorey',
        target: { modelId: target.modelId, globalId: product.GlobalId, ifcClass: product.type,
          name: typeof product.attributes[2] === 'string' ? product.attributes[2] : '' },
        sourceStorey, destinationStorey, expected };
      const batchRefusal = completeBatchRefusal(operation);
      if (batchRefusal) { onRefusal?.(batchRefusal); continue; }
      const json = JSON.stringify(expected), expectedJsonParts = Array.from({ length: Math.ceil(json.length / 1000) }, (_, i) => json.slice(i * 1000, (i + 1) * 1000));
      results.push({ sourceStorey, destinationStorey, expectedJsonParts, productCount: expected.products.length });
    }
  } catch (error) { if (!(error instanceof Error)) throw error; }
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
