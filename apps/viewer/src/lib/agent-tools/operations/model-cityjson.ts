/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { cityJsonEngine, hasSessionGeoref, produceNativeCityJson } from '@/lib/export/native-cityjson';
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
  const produced = await produceNativeCityJson(engine, model, useViewerStore.getState().getMutationView, i.sequence).catch((error: unknown) => {
    const refusal = engine.cityJsonRefusalReason(error);
    if (refusal === null) console.error('CityJSON export failed:', error);
    throw new Error(refusal ?? (error instanceof Error ? error.message : String(error)), { cause: error });
  });
  // As the dialog warns: session georeferencing edits are not in the STEP source, so they are not in the export.
  const warnings = hasSessionGeoref(useViewerStore.getState().georefMutations, model.id)
    ? ['Session georeferencing edits are not applied; the export uses the file\'s own georeferencing or local coordinates.', ...produced.warnings]
    : produced.warnings;
  return nativeArtifact(c, produced.blob, produced.filename, { warnings }, check);
})];
