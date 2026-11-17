/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityExtractor, effectiveMetadataRecord, getAttributeNamesForSchema, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/** One finite index build: schema positions are resolved once per type (#9928).
 * Edited/source-free stores retain the canonical effective-record semantics. */
export function presentationLayerReader(store: IfcDataStore, view?: MutablePropertyView) {
  const positions = new Map<string, Map<string, number>>();
  const extractor = new EntityExtractor(store.source);
  const read = (id: number) => {
    if (view || !store.source.length) {
      const record = effectiveMetadataRecord(store, id, view);
      return record ? { type: record.type, value: (name: string): unknown => record.attributes[record.names.indexOf(name)] } : null;
    }
    // @raw-entity-enumeration-ok no overlay exists here; edited rows use effectiveMetadataRecord above.
    const ref = store.entityIndex.byId.get(id);
    if (!ref) return null;
    let names = positions.get(ref.type);
    if (!names) {
      names = new Map(getAttributeNamesForSchema(ref.type, store.schemaVersion).map((name, index) => [name, index]));
      positions.set(ref.type, names);
    }
    const fields = names;
    return { type: ref.type, value: (name: string): unknown => {
      const index = fields.get(name);
      return index === undefined ? undefined : extractor.extractAttribute(ref, index);
    } };
  };
  return read;
}
