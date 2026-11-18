/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { modelExportFilename } from '@/lib/export/download';
import { isStepSourceModel, resolveStepExportBytes } from '@/components/viewer/step-export-source';
import { viewerOperation } from './contract';
import { exportMetadata } from './exports-common';
import { nativeArtifact, nativeExportGuard, targetSchema } from './export-native-runtime';

/** The toolbar CityJSON dialog's producer (#10612): edited STEP source, then the geometry package's CityJSON writer. */
export const cityJsonExportOperations = [viewerOperation<{ target_model_id: string; sequence: boolean }>(exportMetadata('exports.cityjson',
  'Produce native CityJSON (or CityJSONSeq with sequence=true) from the explicit model\'s current edited IFC source, through the same producer as the toolbar dialog. A model without georeferencing exports in local coordinates; producer warnings are returned, and package refusals (for example no IfcBuilding) are errors.'), {
  type: 'object', properties: { target_model_id: targetSchema, sequence: { type: 'boolean' } }, required: ['target_model_id', 'sequence'], additionalProperties: false,
}, async (i, c) => {
  const model = useViewerStore.getState().models.get(i.target_model_id);
  if (!model) throw new Error('Unknown loaded native model ID.');
  if (!isStepSourceModel(model)) throw new Error('Native CityJSON export requires a retained .ifc/.ifczip source.');
  const check = nativeExportGuard(c, [model.id]); check();
  const { exportCityJson, cityJsonRefusalReason } = await import('@ifc-lite/geometry');
  const bytes = await resolveStepExportBytes(model, useViewerStore.getState().getMutationView); check();
  let result: Awaited<ReturnType<typeof exportCityJson>>;
  try { result = await exportCityJson(bytes, { sequence: i.sequence }); }
  catch (error) { throw new Error(cityJsonRefusalReason(error) ?? (error instanceof Error ? error.message : String(error))); }
  const blob = new Blob([result.text], { type: i.sequence ? 'application/x-ndjson' : 'application/json' });
  return nativeArtifact(c, blob, modelExportFilename(model.name, i.sequence ? 'city.jsonl' : 'city.json'), { warnings: result.warnings }, check);
})];
