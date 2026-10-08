/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createTranslationService, validateIDS, type IDSDocument, type IDSValidationReport, type SupportedLocale, type ValidationProgress } from '@ifc-lite/ids';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { canUseIdsWorker } from '@/hooks/ids/canUseIdsWorker';
import { runValidationInWorker } from '@/hooks/ids/idsWorkerClient';
import { snapshotPropertyOverlay, snapshotEntityVisibility } from '@/lib/ids/property-overlay-snapshot';
import { getWholeSourceForWorker } from '@/lib/overlay-parse';
import { validationReportSnapshot, type ReportScopeModel } from './reports/history';

export interface RunIdsCheckOptions {
  document: IDSDocument;
  modelId: string;
  dataStore: IfcDataStore;
  mutationView?: MutablePropertyView | null;
  locale: SupportedLocale;
  models: ReadonlyMap<string, ReportScopeModel>;
  signal?: AbortSignal;
  onProgress?: (progress: ValidationProgress) => void;
  snapshotId?: string;
}

export function throwIfCheckAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Validation cancelled', 'AbortError');
}

/** Execute one native IDS check without publishing UI state or recoloring.
 * Cancellation never starts a fallback; non-abortable main-thread validation
 * must settle before this service releases its report and input resources. */
export async function runIdsCheck(options: RunIdsCheckOptions) {
  const { document, modelId, dataStore, mutationView, locale, signal } = options;
  throwIfCheckAborted(signal);
  const reportModels = new Map([...options.models].map(([id, model]) => [id, { ...model }]));
  const evaluatedModel = reportModels.get(modelId);
  if (evaluatedModel) reportModels.set(modelId, { ...evaluatedModel, ifcDataStore: dataStore });
  const schemaVersion = dataStore.schemaVersion || 'IFC4';
  const onProgress = (progress: ValidationProgress) => {
    if (!signal?.aborted) options.onProgress?.(progress);
  };
  let report: IDSValidationReport | undefined;
  if (canUseIdsWorker(dataStore)) {
    try {
      const editedView = mutationView?.hasPendingChanges() ? mutationView : undefined;
      report = await runValidationInWorker({
        source: getWholeSourceForWorker(dataStore), document, schemaVersion, modelId, locale,
        includePassingEntities: true,
        propertyOverlay: editedView ? snapshotPropertyOverlay(editedView) : undefined,
        entityVisibility: editedView ? snapshotEntityVisibility(editedView) : undefined,
        signal, onProgress,
      });
    } catch (error) {
      // The worker can signal cancellation independently of the caller's
      // controller. Both forms terminate rather than validate a second time.
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      console.warn('[IDS] Worker validation failed; falling back to main thread.', error);
    }
  }
  throwIfCheckAborted(signal);
  if (!report) {
    const accessor = createDataAccessor(dataStore, modelId, mutationView);
    report = await validateIDS(document, accessor, {
      modelId, schemaVersion, entityCount: dataStore.entityCount || accessor.getAllEntityIds().length,
    }, { translator: createTranslationService(locale), onProgress, includePassingEntities: true });
  }
  throwIfCheckAborted(signal);
  return { report, snapshot: validationReportSnapshot(report, reportModels, options.snapshotId ?? 'run') };
}
