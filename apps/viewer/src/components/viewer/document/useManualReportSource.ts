/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a manual report block (#6401) snapshots: the working checklist from
 * `manualValidationSlice` and one model's answers, picked by the same rule
 * the Manual validation tab uses (`pickManualModel`). Shared by the Add
 * block menu and the block's Refresh button.
 */

import { useCallback, useMemo } from 'react';
import { useViewerStore } from '@/store';
import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import type { ManualReportBlock } from '@/lib/document/manual-report-types';
import { reportModelScope } from '@/lib/document/report-provenance';
import { answersForModel, manualModelOptions, pickManualModel, type ManualModelOption } from '@/lib/validation/manual/manual-model';

export interface ManualReportSourceHandle {
  /** False until a checklist exists in the Manual validation tab. */
  available: boolean;
  checklists: Array<{ id: string; name: string }>;
  /** Add chooses an explicit source even when the editor is closed. */
  defaultChecklistId: string | null;
  activeChecklistId: string | null;
  models: ManualModelOption[];
  /** The model a snapshot reads when none is picked. */
  defaultModelId: string | null;
  /**
   * A fresh snapshot under `id` of `modelId`'s answers (null: the default
   * model), or null without a checklist or when `modelId` is not loaded.
   */
  snapshot: (id: string, modelId?: string | null, checklistId?: string) => ManualReportBlock | null;
}

export function useManualReportSource(): ManualReportSourceHandle {
  const library = useViewerStore((s) => s.manualLibrary);
  const storeModels = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const models = useMemo(() => manualModelOptions(storeModels), [storeModels]);
  const defaultChecklistId = library.activeId ?? library.checklists[0]?.id ?? null;
  const defaultEntry = library.checklists.find(entry => entry.id === defaultChecklistId);
  const defaultModelId = pickManualModel(models, null, activeModelId, defaultEntry?.preferredModelFingerprint)?.id ?? null;
  const checklists = useMemo(() => library.checklists.map((entry) => ({ id: entry.id, name: entry.template.name })), [library.checklists]);

  const snapshot = useCallback((id: string, modelId: string | null = null, checklistId?: string) => {
    const entry = library.checklists.find((candidate) => candidate.id === (checklistId ?? library.activeId));
    if (!entry) return null;
    const model = modelId === null ? pickManualModel(models, null, activeModelId, entry.preferredModelFingerprint) : models.find((m) => m.id === modelId);
    if (model === undefined || (model === null && entry.preferredModelFingerprint)) return null;
    const scope = model ? reportModelScope(model.name, model.id, model.fingerprint) : null;
    return {
      ...manualReportBlockFromChecklist({
        checklist: entry.template, checklistId: entry.id, answers: answersForModel(entry.answers, model), modelName: scope?.name, modelFingerprint: model?.fingerprint,
      }, id),
      ...(scope ? { reportModels: [scope] } : {}),
    };
  }, [library.checklists, library.activeId, models, activeModelId]);

  return { available: checklists.length > 0, checklists, defaultChecklistId, activeChecklistId: library.activeId, models, defaultModelId, snapshot };
}
