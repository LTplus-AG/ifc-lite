/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bake a live mutation view into matching STEP bytes and a parsed store. */

import { StepExporter } from '@ifc-lite/export';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { SchemaVersion } from '@/store/types';
import { resolveEnergyExportMutationSource } from '@/components/viewer/energy-export-source';

export async function materializeEffectiveIfcStore(
  store: IfcDataStore,
  mutationView: MutablePropertyView | null,
  schemaVersion: SchemaVersion,
): Promise<IfcDataStore> {
  const source = resolveEnergyExportMutationSource({ mutationView, dataStore: store, schemaVersion });
  if (!source) return store;
  const exported = new StepExporter(source.dataStore, source.mutationView).export({
    schema: source.dataStore.schemaVersion,
    applyMutations: true,
    includeGeometry: true,
    includeQuantities: true,
  });
  // slice() yields an exact-length ArrayBuffer-backed copy for the parser.
  return new IfcParser().parseColumnar(exported.content.slice().buffer, { disableWorkerScan: true });
}
