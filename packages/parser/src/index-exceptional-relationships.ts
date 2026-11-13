/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from './columnar-parser.js';
import { CurrentQuantityRefusal, readRelation } from './current-type-relationships.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import { propertyDefinitionRefsOfValue } from './property-definition-refs.js';
import { resolveRelationshipRecord, type RelationshipOverlayReader } from './effective-relationship-overlay.js';
import { createSchemaEntityNameSnapshot } from './schema-entity-name.js';
import { getSchemaRegistryForVersion } from './generated/schema-registry-by-version.js';
import type { SelectionRelationshipIndex } from './selection-relationship-index.js';
const noEdits: MetadataReadView = {
  isDeleted: () => false, getNewEntity: () => null, getNewEntities: () => [], getMutationRevision: () => 0,
  getPositionalMutationsForEntity: () => null, getAttributeMutationsForEntity: () => [],
};
function add(map: Map<number, number[]>, key: number, id: number): void {
  const ids = map.get(key) ?? []; ids.push(id); map.set(key, ids);
}

/** Run in the parser worker while source is resident. Native reads historically
 * validate unindexed rows globally; carrying their facts avoids repeating that
 * validation on the first selection, including files with many lenient STEP refs. */
export async function indexExceptionalTypeCoverage(store: IfcDataStore, index: SelectionRelationshipIndex, pause: () => Promise<void>): Promise<void> {
  for (let i = 0; i < index.unverifiedTypeRows.length; i++) {
    if ((i & 255) === 0) await pause();
    const id = index.unverifiedTypeRows[i];
    try {
      const record = effectiveMetadataRecord(store, id, noEdits);
      if (record?.type.toUpperCase() === 'IFCRELDEFINESBYPROPERTIES') {
        for (const target of new Set(propertyDefinitionRefsOfValue(record.attributes[5]))) add(index.exceptionalDefinitionTargets, target, id);
      }
      const row = readRelation(store, id, noEdits);
      const references = row ? row.members.length * row.targets.length : 0;
      index.typeReferences += references;
      index.typeExceptionalReferences.set(id, references);
    } catch (error) {
      if (error instanceof CurrentQuantityRefusal) index.typeRefusals.set(id, error.message);
      else {
        // Do not turn an unexpected/transient reader failure into a permanent
        // model refusal. The current read retries this exceptional row.
        console.warn('[parser] Exceptional type coverage requires a retry', error);
        index.retryTypeRows.push(id);
      }
    }
  }
}

/** Only the exceptional rows need a second endpoint grammar, not a second
 * model walk. Keep native compatibility without adding unsafe edges to CSR. */
export async function indexExceptionalSubjects(store: IfcDataStore, index: SelectionRelationshipIndex, ids: readonly number[], pause: () => Promise<void>): Promise<void> {
  if (!ids.length) return;
  const snapshot = createSchemaEntityNameSnapshot(getSchemaRegistryForVersion(store.schemaVersion === 'IFC2X3' ? 'IFC2X3' : store.schemaVersion === 'IFC4X3' || store.schemaVersion === 'IFC5' ? 'IFC4X3' : 'IFC4'));
  const reader: RelationshipOverlayReader = { createdEntities: () => [], mutatedEntityIds: () => [],
    namedAttributes: () => [], positionalAttributes: () => [], isDeleted: () => false };
  for (let i = 0; i < ids.length; i++) {
    if ((i & 255) === 0) await pause();
    const id = ids[i];
    try {
      const entity = store.getEntity(id);
      if (!entity) continue;
      const row = resolveRelationshipRecord(store, entity, reader, snapshot);
      if (row) for (const subject of new Set(row.related)) add(index.exceptionalSubjects, subject, id);
    } catch (error) {
      // A selection still retries this record through the canonical reader.
      console.warn('[parser] Exceptional relationship indexing requires a retry', error);
      if (!index.retryTypeRows.includes(id)) index.retryTypeRows.push(id);
    }
  }
}
