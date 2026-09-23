/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type StoreEditor } from '@ifc-lite/mutations';
import { EntityExtractor, resolveEffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';

export interface StyleEntity {
  type: string;
  attributes: readonly unknown[];
}

/** Source refs are numeric; authored refs use `#123` strings. */
export function asRef(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^#0*[1-9][0-9]*$/.test(value)) {
    const id = Number(value.slice(1));
    return Number.isSafeInteger(id) ? id : null;
  }
  return null;
}

export function refList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const id = asRef(item);
    if (id !== null) out.push(id);
  }
  return out;
}

/** Read one live entity as the next export will write it (#5249). */
export function createStyleEntityReader(store: IfcDataStore, editor: StoreEditor): (id: number) => StyleEntity | null {
  const view = editor.getMutationView();
  const extractor = store.source.byteLength > 0 ? new EntityExtractor(store.source) : null;
  return (id) => {
    if (!editor.hasEntity(id)) return null;
    const created = view.getNewEntity(id);
    // @raw-entity-enumeration-ok point lookup for one effective candidate's source attributes
    const ref = created ? undefined : (
      store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id)
    );
    const source = ref && extractor ? extractor.extractEntity(ref) : null;
    const entity = created ?? source;
    if (!entity) return null;
    return resolveEffectiveEntityRecord(entity, {
      retype: view.getEntityTypeMutation(id)?.newType,
      named: view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value] as const),
      positional: view.getPositionalMutationsForEntity(id) ?? [],
    }, store.schemaVersion);
  };
}

/** One live styled item per target, including authored styles and retypes. */
export function indexExistingStyles(
  store: IfcDataStore,
  editor: StoreEditor,
  read: (id: number) => StyleEntity | null,
): Map<number, number> {
  const styledBy = new Map<number, number>();
  for (const { expressId } of iterateEffectiveEntityIds(store, editor.getMutationView(), ['IFCSTYLEDITEM'])) {
    const target = asRef(read(expressId)?.attributes[0]);
    if (target !== null) styledBy.set(target, expressId);
  }
  return styledBy;
}
