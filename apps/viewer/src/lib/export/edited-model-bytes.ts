/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The STEP bytes a whole-file consumer should read for a model: the model as
 * the user edited it, not the file as loaded (#5397, charter #5249).
 *
 * The CSV exports run in Rust over raw STEP bytes. Handing them
 * `ifcDataStore.source` re-parses the file as loaded: an entity deleted this
 * session was exported, one created this session was not, and every property,
 * attribute and retype edit was missing. A model whose mutation view carries
 * real edits is re-serialized through `StepExporter` with the mutations
 * applied, which is the same rule and the same bytes the USD and energy
 * exports use (`resolveEnergyExportMutationSource`). An unedited model returns
 * its source bytes unchanged.
 */

import { StepExporter } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { SchemaVersion } from '@/store/types';
import { resolveEnergyExportMutationSource } from '@/components/viewer/energy-export-source';

export function editedModelBytes(store: IfcDataStore, view: MutablePropertyView | null): Uint8Array {
  const source = resolveEnergyExportMutationSource({
    mutationView: view,
    dataStore: store,
    schemaVersion: store.schemaVersion as SchemaVersion,
  });
  if (!source) return store.source.materialize();
  return new StepExporter(source.dataStore, source.mutationView).export({
    schema: source.dataStore.schemaVersion,
    applyMutations: true,
    includeGeometry: true,
    includeQuantities: true,
  }).content;
}
