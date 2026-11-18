/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { cityJsonEngine, produceNativeCityJson } from '@/lib/export/native-cityjson';
import { viewerOperation } from './contract';
import { exportCheckpoint, exportMetadata } from './exports-common';
import { nativeArtifact, nativeStepTarget, targetSchema } from './export-native-runtime';

/** The toolbar CityJSON dialog's producer (#10612), returned as a host-owned artifact. */
export const cityJsonExportOperations = [viewerOperation<{ target_model_id: string; sequence: boolean }>(exportMetadata('exports.cityjson',
  'Produce native CityJSON (or CityJSONSeq with sequence=true) from the explicit model\'s current edited IFC source, through the same producer as the toolbar dialog. A model without georeferencing exports in local coordinates; producer warnings are returned, and package refusals (for example no IfcBuilding) are errors.'), {
  type: 'object', properties: { target_model_id: targetSchema, sequence: { type: 'boolean' } }, required: ['target_model_id', 'sequence'], additionalProperties: false,
}, async (i, c) => {
  const model = nativeStepTarget(i.target_model_id);
  // CityJSON reads only the model and its edits, not view state, so the narrower export checkpoint applies.
  const check = exportCheckpoint(c, [model.id]); check();
  const engine = await cityJsonEngine.load();
  const produced = await produceNativeCityJson(engine, model, useViewerStore.getState().getMutationView, i.sequence)
    .catch((error: unknown) => { throw new Error(engine.cityJsonRefusalReason(error) ?? (error instanceof Error ? error.message : String(error))); });
  return nativeArtifact(c, produced.blob, produced.filename, { warnings: produced.warnings }, check);
})];
