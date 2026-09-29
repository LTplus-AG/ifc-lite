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
import { answersForModel, manualModelOptions, pickManualModel, type ManualModelOption } from '@/lib/validation/manual/manual-model';

export interface ManualReportSourceHandle {
  /** False until a checklist exists in the Manual validation tab. */
  available: boolean;
  models: ManualModelOption[];
  /** The model a snapshot reads when none is picked. */
  defaultModelId: string | null;
  /** A fresh snapshot under `id`, or null without a checklist. */
  snapshot: (id: string, modelId?: string | null) => ManualReportBlock | null;
}

export function useManualReportSource(): ManualReportSourceHandle {
  const checklist = useViewerStore((s) => s.manualChecklist);
  const answers = useViewerStore((s) => s.manualAnswers);
  const storeModels = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const models = useMemo(() => manualModelOptions(storeModels), [storeModels]);
  const defaultModelId = pickManualModel(models, null, activeModelId)?.id ?? null;

  const snapshot = useCallback((id: string, modelId: string | null = null) => {
    if (!checklist) return null;
    const model = pickManualModel(models, modelId, activeModelId);
    return manualReportBlockFromChecklist({ checklist, answers: answersForModel(answers, model), modelName: model?.name }, id);
  }, [checklist, answers, models, activeModelId]);

  return { available: checklist !== null, models, defaultModelId, snapshot };
}
