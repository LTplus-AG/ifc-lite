/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { answersForModel, type ManualModelOption } from '@/lib/validation/manual/manual-model';
import { summarizeChecklist } from '@/lib/validation/manual/checklist-summary';

/** Instance identity owns the answers; model identity only chooses which
 * answers to show. Completion uses the same canonical summary as the rings. */
export function ManualChecklistLibrary({ model, onNew, onSelected, active }: {
  model: ManualModelOption | null;
  onNew: () => void;
  onSelected: (editing: boolean) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const library = useViewerStore((state) => state.manualLibrary);
  if (!library.checklists.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b p-2" data-manual-checklist-library>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        {t('manualValidation.library.select')}
        <select className="h-7 min-w-0 rounded border border-input bg-background px-1.5" aria-label={t('manualValidation.library.select')} value={library.activeId ?? ''}
          onChange={(event) => {
            const entry = library.checklists.find((candidate) => candidate.id === event.target.value);
            if (!entry) return;
            useViewerStore.getState().selectManualChecklist(entry.id);
            onSelected(entry.template.groups.length === 0);
          }}>
          <option value="" disabled>{t('manualValidation.library.none')}</option>
          {library.checklists.map((entry) => {
            const counts = summarizeChecklist(entry.template, answersForModel(entry.answers, model)).overall;
            const completed = counts.total - counts.unanswered;
            const percent = counts.total ? Math.round(completed * 100 / counts.total) : 0;
            return <option key={entry.id} value={entry.id}>{entry.template.name.trim() || t('manualValidation.name.placeholder')} · {t('manualValidation.library.progress', { completed, total: counts.total, percent })}</option>;
          })}
        </select>
      </label>
      {active && <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={onNew}>{t('manualValidation.entry.new')}</Button>}
      {active && <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => {
        const entry = library.checklists.find((candidate) => candidate.id === library.activeId);
        if (!entry) return;
        useViewerStore.getState().duplicateManualChecklist(entry.id, t('manualValidation.library.copyName', { name: entry.template.name.trim() || t('manualValidation.name.placeholder') }));
        onSelected(entry.template.groups.length === 0);
      }}>{t('manualValidation.library.duplicate')}</Button>}
      <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={!library.activeId} onClick={() => {
        if (!library.activeId) return;
        useViewerStore.getState().removeManualChecklist(library.activeId);
        const next = useViewerStore.getState().manualChecklist;
        onSelected(next !== null && next.groups.length === 0);
      }}>{t('manualValidation.library.remove')}</Button>
    </div>
  );
}
