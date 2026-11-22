/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { StepExporter } from '@ifc-lite/export';
import { createExportAdapterWithWriter } from './export-adapter-core.js';
import type { StoreApi } from './types.js';

export { resolveVisibilityFilterSets } from './export-adapter-step.js';
export { injectScheduleIntoStep, type InjectScheduleOptions } from './export-schedule-inject.js';

/** Standalone SDK adapters can serialize STEP synchronously on the first call. */
export function createExportAdapter(store: StoreApi) {
  return createExportAdapterWithWriter(store, () => StepExporter);
}
