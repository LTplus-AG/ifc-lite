/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '@/store';
import { summarizeChecklist } from '@/lib/validation/manual/checklist-summary';
import { answersForModel, manualModelOptions, type ManualModelOption } from '@/lib/validation/manual/manual-model';
import type { ChecklistTemplate, ManualAnswerMap } from '@/lib/validation/manual/checklist';
import { useValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const TEXT_BOUND = 500;
const bound = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : text.length > TEXT_BOUND ? `${text.slice(0, TEXT_BOUND)}…` : text;

const itemCount = (template: ChecklistTemplate): number =>
  template.groups.reduce((sum, group) => sum + group.items.length, 0);

/** The latest answer edit among the checklist's own items, or null when none is recorded. */
function latestAnswerAt(template: ChecklistTemplate, answers: ManualAnswerMap): number | null {
  let latest: number | null = null;
  for (const group of template.groups) for (const item of group.items) {
    const at = answers[item.id]?.updatedAt;
    if (at !== undefined && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

/** Loaded models that can hold answers; with none, one unanswerable pseudo-target keeps the checklist itself visible. */
function targetsOf(s: ViewerState): Array<ManualModelOption | null> {
  const models = manualModelOptions(s.models).filter(option => option.fingerprint !== null);
  return models.length > 0 ? models : [null];
}

/** The open manual checklist and its human verdicts for every loaded model. */
export const manualChecklistAdapter: EvidenceAdapter = {
  id: 'manualChecklist', group: 'checks', panelIds: ['validation'],
  panelSubject: () => useValidationSourceChoice.getState().choice === 'manual',
  titleKey: 'assistantSources.manualChecklist.title', descriptionKey: 'assistantSources.manualChecklist.description',
  rowMeaningKey: 'assistantSources.manualChecklist.rows', unavailableKey: 'assistantSources.manualChecklist.unavailable',
  suggestionKeys: ['assistantSources.manualChecklist.suggestSummary', 'assistantSources.manualChecklist.suggestOpen'],
  readiness: s => s.manualChecklist
    ? { status: { labelKey: 'assistantSources.manualChecklist.pickItems', params: { count: itemCount(s.manualChecklist) } }, ready: true }
    : { status: { labelKey: 'assistantSources.manualChecklist.pickNone' }, ready: false },
  identity: s => [s.manualLibrary, s.manualChecklist, s.manualAnswers],
  capture: (s, limit) => {
    const checklist = s.manualChecklist;
    if (!checklist) return unavailableCapture();
    const targets = targetsOf(s);
    const items = itemCount(checklist);
    const rows: unknown[] = [];
    let latest: number | null = null;
    const models = targets.map(model => {
      const answers = answersForModel(s.manualAnswers, model);
      const modelLatest = latestAnswerAt(checklist, answers);
      if (modelLatest !== null && (latest === null || modelLatest > latest)) latest = modelLatest;
      for (const group of checklist.groups) for (const item of group.items) {
        if (rows.length >= limit) break;
        const answer = answers[item.id];
        rows.push(evidenceRow({ kind: 'manualCheck', modelId: model?.id ?? null, status: answer?.status ?? null }, {
          modelFingerprint: model?.fingerprint ?? null, groupName: group.name, itemId: item.id, text: bound(item.text),
          description: bound(item.description), comment: bound(answer?.comment), answeredAt: iso(answer?.updatedAt ?? null),
        }));
      }
      return { modelId: model?.id ?? null, modelName: model?.name ?? null, modelFingerprint: model?.fingerprint ?? null,
        counts: summarizeChecklist(checklist, answers).overall, latestAnswerAt: iso(modelLatest) };
    });
    const loaded = new Set(targets.flatMap(model => (model?.fingerprint ? [model.fingerprint] : [])));
    return {
      summary: {
        kind: 'manual-checklist', checklistName: checklist.name, checklistId: s.manualLibrary.activeId,
        checklistsInLibrary: s.manualLibrary.checklists.length, groupCount: checklist.groups.length, itemCount: items,
        models, latestAnswerAt: iso(latest),
        answeredModelsNotLoaded: Object.keys(s.manualAnswers).filter(fingerprint => !loaded.has(fingerprint)).length,
        units: { counts: 'checklist items' },
        limitations: 'Statuses are human verdicts entered by a reviewer in the manual checklist, not results computed by a native check; they record what the reviewer decided, not that the model was verified. Status null means not answered yet (a comment may exist). Answers belong to a model source fingerprint; answers for models that are not loaded are counted but not listed. Rows list each item once per loaded model.',
      },
      rows, totalRows: items * targets.length, availability: 'available',
    };
  },
};
