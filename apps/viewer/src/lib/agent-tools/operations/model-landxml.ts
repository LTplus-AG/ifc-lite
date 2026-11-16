/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { landXmlExportPlan } from '@/lib/export/landXmlIfcPlan';
import { landXmlDownloadInput, buildLandXmlIfcArtifact } from '@/lib/export/landXmlIfcDownload';
import { viewerOperation } from './contract';
import { exportCheckpoint, exportMetadata } from './exports-common';
export const landXmlExportOperations = [viewerOperation<{ target_model_id: string }>(exportMetadata('exports.landXmlIfc', 'Produce the native mapped IFC4X3/IFCZIP conversion of an explicit loaded LandXML model, including source hashing, terrain/survey/alignment semantics, CRS naming and draped imagery. Shares the Export dialog producer and its exact refusal/imagery diagnostics. Native conversion may finish after cancellation; no artifact is retained after cancelled preparation. No download.'), {
  type: 'object', properties: { target_model_id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['target_model_id'], additionalProperties: false,
}, async (i, c) => {
  const current = exportCheckpoint(c, [i.target_model_id]); current();
  const state = useViewerStore.getState(), model = state.models.get(i.target_model_id);
  if (!model) throw new Error('Unknown loaded native model ID.');
  const plan = landXmlExportPlan(state.models, model, false);
  const source = landXmlDownloadInput(plan, 'IFC4X3', model);
  if (!source) throw new Error(`Native LandXML mapping does not cover this model: ${JSON.stringify(plan)}`);
  const result = await buildLandXmlIfcArtifact(source);
  current();
  if (result.status === 'refused') throw new Error(result.reason);
  const { blob, ...diagnostics } = result;
  return { artifact: await c.artifacts.create({ data: blob, filename: result.filename, mimeType: blob.type }), diagnostics_json: JSON.stringify(diagnostics) };
})];
