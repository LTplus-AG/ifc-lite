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
  'Produce native CityJSON (or CityJSONSeq with sequence=true) from the explicit model\'s current edited IFC source, through the same producer as the toolbar dialog. Session georeferencing edits are written; a model without georeferencing exports in local coordinates; producer warnings are returned, and package refusals (for example no IfcBuilding) are errors.'), {
  type: 'object', properties: { target_model_id: targetSchema, sequence: { type: 'boolean' } }, required: ['target_model_id', 'sequence'], additionalProperties: false,
}, async (i, c) => {
  const model = nativeStepTarget(i.target_model_id);
  // CityJSON reads only the model and its edits, not view state, so the narrower export checkpoint applies.
  const check = exportCheckpoint(c, [model.id]); check();
  const engine = await cityJsonEngine.load(); check();
  const { getMutationView, georefMutations } = useViewerStore.getState();
  // A checkpoint stop is not a writer failure: it passes through unlogged and keeps its code.
  let stopped: unknown;
  const gate = () => { try { check(); } catch (error) { stopped = error; throw error; } };
  const produced = await produceNativeCityJson(engine, model, getMutationView, georefMutations.get(model.id), i.sequence, gate).catch((error: unknown) => {
    if (error === stopped) throw error;
    const refusal = engine.cityJsonRefusalReason(error);
    if (refusal === null) console.error('CityJSON export failed:', error);
    throw new Error(refusal ?? (error instanceof Error ? error.message : String(error)), { cause: error });
  });
  return nativeArtifact(c, produced.blob, produced.filename, { warnings: produced.warnings }, check);
})];
