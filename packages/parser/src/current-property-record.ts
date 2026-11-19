/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcAttributeValue, PropertySet } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { EntityExtractor, type IfcEntity } from './entity-extractor.js';
import { getEntityRefFromStore } from './columnar-parser-root-attributes.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';

/** Optional sparse indexes keep a property lookup local to its subject. */
export interface PropertyReadView extends MetadataReadView {
  getAttributeOverrideEntityIds?(types?: readonly string[], referencedId?: number): number[];
  getNewEntitiesReferencing?(id: number): Iterable<{ expressId: number; type: string }>;
  getForEntity?(id: number, base?: (baseId: number) => PropertySet[]): PropertySet[];
}

export function propertyReference(value: unknown): number | null {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^#[1-9]\d*$/.test(value) ? Number(value.slice(1)) : null;
  return id !== null && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The metadata reader normalizes the same typed values the STEP writer emits. */
export function propertyRecord(store: IfcDataStore, id: number, view?: MetadataReadView, extractor?: EntityExtractor): IfcEntity | null {
  if (view) {
    const row = effectiveMetadataRecord(store, id, view);
    // MetadataReadView's source and mutation payloads are IfcAttributeValue;
    // the generic schema re-layout widens their array to unknown[].
    return row ? { expressId: id, type: row.type, attributes: row.attributes as IfcAttributeValue[] } : null;
  }
  const ref = getEntityRefFromStore(store, id);
  return ref && store.source.length ? (extractor ?? new EntityExtractor(store.source)).extractEntity(ref) : null;
}
