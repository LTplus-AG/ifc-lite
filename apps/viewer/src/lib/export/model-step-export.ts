/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StepExporter, type StepExportOptions } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { prepareAppearanceSerialization } from '../appearance/serialization.js';
import { roomStepExportSource } from '../collab/room-step-export.js';
import { spliceScheduleIntoExport, type ExportScheduleState } from '@/sdk/adapters/export-schedule-splice';

/** One edited STEP source for downloads and cloud uploads (#6587).
 * Visibility ids belong to the viewer model; portable room sources remap them.
 * Return image resources alongside STEP so no transport silently loses them.
 */
export async function exportModelStep(input: {
  modelId: string;
  dataStore: IfcDataStore;
  mutationView?: MutablePropertyView;
  options: StepExportOptions;
  scheduleState: ExportScheduleState | null;
}) {
  const { modelId, options } = input;
  const portable = roomStepExportSource(input.dataStore, input.mutationView, modelId);
  const dataStore = portable?.dataStore ?? input.dataStore;
  const view = portable ? portable.mutationView : input.mutationView;
  const serialized = prepareAppearanceSerialization(modelId, dataStore, options.applyMutations !== false ? view : undefined);
  const result = await new StepExporter(dataStore, serialized.view).exportAsync({
    ...options,
    hiddenEntityIds: portable ? portable.toSourceIds(options.hiddenEntityIds) ?? undefined : options.hiddenEntityIds,
    isolatedEntityIds: portable ? portable.toSourceIds(options.isolatedEntityIds) : options.isolatedEntityIds,
  });
  const spliced = input.scheduleState
    ? spliceScheduleIntoExport(result, modelId, dataStore, input.scheduleState)
    : result;
  return { content: spliced.content, stats: result.stats, resources: serialized.resources };
}
