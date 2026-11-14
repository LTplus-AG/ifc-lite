/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from './columnar-parser.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import type { StructuralExtractionView } from './structural-extractor.js';

/**
 * Adapt an editable overlay to the structural read model, so
 * `extractStructuralOnDemand` sees deletions, created and retyped records and
 * edited attributes. The viewer's properties card and the structural
 * derivation in `@ifc-lite/create` both read through this one adapter.
 */
export function effectiveStructuralView(store: IfcDataStore, view: MetadataReadView): StructuralExtractionView {
  return {
    isDeleted: (expressId) => view.isDeleted(expressId),
    getNewEntities: () => view.getNewEntities(),
    getNewEntitiesOfType: view.getNewEntitiesOfType?.bind(view),
    getNewEntity: (expressId) => view.getNewEntity(expressId),
    getTypeMutations: view.getTypeMutations?.bind(view),
    getTombstones: view.getTombstones?.bind(view),
    readEntity: (expressId) => {
      const record = effectiveMetadataRecord(store, expressId, view);
      return record ? { expressId, type: record.type, attrs: record.attributes,
        globalId: typeof record.attributes[0] === 'string' ? record.attributes[0] : '' } : undefined;
    },
  };
}
