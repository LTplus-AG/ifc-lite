/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: remove a single-flight stair assembly, retaining shared geometry
 * and styles. Generic StoreEditor.removeEntity remains a one-record operation. */
import { iterateEffectiveEntityIds, type StoreEditor } from '@ifc-lite/mutations';
import { getSchemaRegistryForVersion, type IfcDataStore, type SchemaRegistry } from '@ifc-lite/parser';
import { AnchorEntityReader } from './resolve-anchor.js';
import { asRef, refList } from './style-entity-reader.js';

function referenceType(registry: SchemaRegistry, type: string): boolean {
  const pending = [type], visited = new Set<string>();
  while (pending.length) {
    const candidate = pending.pop()!;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    if (registry.entities[candidate]) return true;
    pending.push(...(registry.selects[candidate] ?? []));
    const alias = registry.types[candidate];
    if (alias) pending.push(alias);
  }
  return false;
}

/** References in an admitted entity slot, without recursive file-supplied walks. */
function referencesPair(value: unknown, pair: ReadonlySet<number>): boolean {
  const pending = [value], visited = new Set<unknown>();
  let work = 0;
  while (pending.length) {
    if (++work > 100_000) throw new Error('removeStairInStore: incoming product references exceed the inspection budget');
    const item = pending.pop();
    if (Array.isArray(item)) {
      if (visited.has(item)) continue;
      visited.add(item);
      if (item.length > 100_000 - work - pending.length) throw new Error('removeStairInStore: incoming product references exceed the inspection budget');
      for (const member of item) pending.push(member);
    } else {
      const id = asRef(item);
      if (id !== null && pair.has(id)) return true;
    }
  }
  return false;
}

/** Resolve the live unique assembly before deleting either product. Shape,
 * placement, style and material leaves remain available to other products;
 * STEP export applies its existing deleted-endpoint relationship filtering. */
export function removeStairInStore(store: IfcDataStore, editor: StoreEditor, stairId: number): { stairId: number; flightId: number } {
  return editor.runAtomic(draft => removeStairFromDraft(store, draft, stairId));
}

/** Package-private guarded removal inside an already-owned atomic transaction. */
export function removeStairFromDraft(store: IfcDataStore, draft: StoreEditor, stairId: number): { stairId: number; flightId: number } {
  const version = store.schemaVersion ?? 'IFC4';
  if (version !== 'IFC2X3' && version !== 'IFC4' && version !== 'IFC4X3') {
    throw new Error(`removeStairInStore: ${version} is not supported`);
  }
  const reader = new AnchorEntityReader(store, draft.getMutationView());
  if (reader.entity(stairId)?.type.toUpperCase() !== 'IFCSTAIR') {
    throw new Error(`removeStairInStore: #${stairId} is not a live IfcStair`);
  }
  const aggregates = [...reader.ids('IFCRELAGGREGATES')].map(id => {
    const entity = reader.entity(id);
    if (!entity) throw new Error(`removeStairInStore: live IfcRelAggregates #${id} cannot be read`);
    return entity;
  });
  const owned = aggregates.filter(entity => asRef(entity.attributes[4]) === stairId);
  const rawMembers = owned.length === 1 ? owned[0].attributes[5] : null;
  const flightId = Array.isArray(rawMembers) && rawMembers.length === 1 ? asRef(rawMembers[0]) : null;
  if (flightId === null || reader.entity(flightId)?.type.toUpperCase() !== 'IFCSTAIRFLIGHT') {
    throw new Error(`removeStairInStore: #${stairId} must aggregate exactly one live IfcStairFlight`);
  }
  if (aggregates.filter(entity => refList(entity.attributes[5]).includes(flightId)).length !== 1
    || aggregates.some(entity => refList(entity.attributes[5]).includes(stairId) || asRef(entity.attributes[4]) === flightId)) {
    throw new Error(`removeStairInStore: #${stairId} or flight #${flightId} belongs to another assembly`);
  }

  const registry = getSchemaRegistryForVersion(version);
  const admitsReferences = new Map<string, boolean>();
  const productSlots = new Map<string, Array<{ index: number; name: string }>>();
  for (const definition of Object.values(registry.entities)) {
    if (definition.name !== 'IfcProduct' && !definition.inheritanceChain?.includes('IfcProduct')) continue;
    const slots: Array<{ index: number; name: string }> = [];
    for (const [index, attribute] of (definition.allAttributes ?? []).entries()) {
      let admitted = admitsReferences.get(attribute.type);
      if (admitted === undefined) {
        admitted = referenceType(registry, attribute.type);
        admitsReferences.set(attribute.type, admitted);
      }
      if (admitted) slots.push({ index, name: attribute.name });
    }
    if (slots.length) productSlots.set(definition.name.toUpperCase(), slots);
  }
  const pair = new Set([stairId, flightId]);
  // Effective type buckets preserve overlay creations/retypes and exclude
  // geometry/property records before the reader materializes attributes.
  for (const { expressId, type } of iterateEffectiveEntityIds(store, draft.getMutationView(), [...productSlots.keys()])) {
    if (pair.has(expressId)) continue;
    const slots = productSlots.get(type);
    if (!slots) continue;
    const entity = reader.entity(expressId);
    if (!entity) throw new Error(`removeStairInStore: live product #${expressId} cannot be read`);
    for (const { index, name } of slots) {
      if (referencesPair(entity.attributes[index], pair)) {
        throw new Error(`removeStairInStore: foreign product #${expressId}.${name} references the stair or flight`);
      }
    }
  }
  if (!draft.removeEntity(flightId) || !draft.removeEntity(stairId)) {
    throw new Error(`removeStairInStore: #${stairId} or flight #${flightId} could not be removed`);
  }
  return { stairId, flightId };
}
