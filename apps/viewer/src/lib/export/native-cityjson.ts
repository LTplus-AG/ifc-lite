/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { resolveStepExportBytes, type StepExportModel } from '@/components/viewer/step-export-source';
import { modelExportFilename } from './download';

export type CityJsonEngine = Pick<typeof import('@ifc-lite/geometry'), 'exportCityJson' | 'cityJsonRefusalReason'>;
/** Load both the facade and the separate export WASM only on demand. An object so tests can fail the load. */
export const cityJsonEngine = { load: (): Promise<CityJsonEngine> => import('@ifc-lite/geometry') };

/** The download name the dialog previews and both producers use. */
export const cityJsonFilename = (name: string, sequence: boolean) => modelExportFilename(name, sequence ? 'city.jsonl' : 'city.json');

/** The CityJSON producer shared by the toolbar dialog and exports.cityjson (#10612): edited STEP source, then the writer. */
export async function produceNativeCityJson(engine: CityJsonEngine, model: StepExportModel & { name: string },
  getMutationView: (modelId: string) => MutablePropertyView | null, sequence: boolean) {
  const result = await engine.exportCityJson(await resolveStepExportBytes(model, getMutationView), { sequence });
  return {
    blob: new Blob([result.text], { type: sequence ? 'application/x-ndjson' : 'application/json' }),
    filename: cityJsonFilename(model.name, sequence),
    warnings: result.warnings,
  };
}
