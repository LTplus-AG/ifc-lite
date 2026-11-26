/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { exportEnergyArtifact, StepExporter } from '@ifc-lite/export';
import { logger } from './logger.js';

async function exportEnergy(
  format: 'HBJSON' | 'DFJSON',
  store: IfcDataStore,
  mutationView: MutablePropertyView | null,
  name: string,
): Promise<string> {
  const consume = async (bytes: Uint8Array) => {
    const { text, warnings } = await exportEnergyArtifact(format, bytes, name);
    for (const warning of warnings) logger.warn(warning);
    return text;
  };
  // Baking needs the original STEP records. Let the exporter report missing
  // source bytes when there are no records to use.
  if (mutationView?.hasPendingChanges() && store.source.byteLength > 0) {
    const schema = store.schemaVersion ?? 'IFC4';
    return consume(new StepExporter(store, mutationView).export({ schema }).content);
  }
  return store.source.withMaterializedAsync(consume);
}

export function exportHbjson(
  store: IfcDataStore,
  mutationView: MutablePropertyView | null,
  name: string,
): Promise<string> {
  return exportEnergy('HBJSON', store, mutationView, name);
}

export function exportDfjson(
  store: IfcDataStore,
  mutationView: MutablePropertyView | null,
  name: string,
): Promise<string> {
  return exportEnergy('DFJSON', store, mutationView, name);
}
