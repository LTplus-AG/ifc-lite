/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Data validation panel's third tab, "Manual validation" (#6401).
 *
 * Without a checklist it shows New / Open / Recent. With one it shows the
 * overall ring and legend, then each group with its own ring and checks.
 * "Edit checklist" switches the rows to their editing face (create, rename,
 * reorder, delete); otherwise the rows take verdicts and comments for the
 * selected model. Answers belong to a model's source fingerprint, so with
 * several models loaded a picker chooses which one is being checked.
 */

import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import { useMemo, useState } from 'react';
import { Pencil, Plus, Save, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { reportModelScope } from '@/lib/document/report-provenance';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { EMPTY_MANUAL_COUNTS, summarizeChecklist } from '@/lib/validation/manual/checklist-summary';
import { answersForModel, manualModelOptions, pickManualModel } from '@/lib/validation/manual/manual-model';
import type { UseManualValidationResult } from '@/hooks/validation/useManualValidation';
import { ManualChecklistLibrary } from './ManualChecklistLibrary';
import { ManualValidationEntry } from './ManualValidationEntry';
import { ManualValidationGroup } from './ManualValidationGroup';
import { ManualValidationLegend, ManualValidationRing } from './ManualValidationRing';

export function ManualValidationTab({ manual }: { manual: UseManualValidationResult }) {
  const { t } = useTranslation();
  const checklist = manual.checklist;
  const storeModels = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const allAnswers = useViewerStore((s) => s.manualAnswers);
  const saveError = useViewerStore((s) => s.manualSaveError);
  const saveErrorMessage = saveError && !saveError.ok && saveError.reason === 'no_checklist'
    ? t('manualValidation.error.noChecklist') : t('manualValidation.error.notSaved');
  const renameChecklist = useViewerStore((s) => s.renameManualChecklist);
  const addGroup = useViewerStore((s) => s.addManualGroup);
  // A brand-new (empty) checklist opens in editing mode; after that the toggle decides.
  const [editing, setEditing] = useState(() => checklist !== null && checklist.groups.length === 0);
  const [pickedModelId, setPickedModelId] = useState<string | null>(null);

  const models = useMemo(() => manualModelOptions(storeModels), [storeModels]);
  const activeModel = pickManualModel(models, pickedModelId, activeModelId);
  const fingerprint = activeModel?.fingerprint ?? null;
  const answers = answersForModel(allAnswers, activeModel);
  const summary = useMemo(() => (checklist ? summarizeChecklist(checklist, answers) : null), [checklist, answers]);

  if (!checklist || !summary) {
    return (
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <ManualChecklistLibrary model={activeModel} active={false} onNew={() => { manual.newChecklist(); setEditing(true); }} onSelected={setEditing} />
        {saveError && <p role="alert" className="text-xs text-red-600">{saveErrorMessage}</p>}
        <ManualValidationEntry
          onNew={() => { manual.newChecklist(); setEditing(true); }}
          onOpenFile={async (file) => { await manual.openFromFile(file); setEditing(false); }}
          onLoadRecent={(entry) => { manual.loadFromRecent(entry); setEditing(false); }}
          recent={manual.recent}
          error={manual.error}
        />
      </div>
    );
  }

  const overallName = t('manualValidation.overall');

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ManualChecklistLibrary model={activeModel} active onNew={() => { manual.newChecklist(); setEditing(true); }} onSelected={setEditing} />
      <div className="flex items-center gap-1.5 border-b p-2">
        <Input
          aria-label={t('manualValidation.name.label')}
          placeholder={t('manualValidation.name.placeholder')}
          value={checklist.name}
          onChange={(e) => renameChecklist(e.target.value)}
          className="h-7 min-w-0 flex-1 px-2 text-xs font-medium"
        />
        <Button
          type="button"
          size="sm"
          variant={editing ? 'default' : 'outline'}
          className="h-7 shrink-0 gap-1 text-xs"
          aria-pressed={editing}
          onClick={() => setEditing(!editing)}
        >
          <Pencil className="h-3.5 w-3.5" />
          {editing ? t('manualValidation.doneEditing') : t('manualValidation.edit')}
        </Button>
        <IconButton label={t('manualValidation.save')} className="h-7 w-7 shrink-0" onClick={manual.save}>
          <Save className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={t('manualValidation.close')} className="h-7 w-7 shrink-0" onClick={manual.close}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-3">
        {models.length > 1 && (
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t('manualValidation.model.label')}</span>
            <select
              aria-label={t('manualValidation.model.label')}
              className="h-7 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
              value={activeModel?.id ?? ''}
              onChange={(e) => setPickedModelId(e.target.value)}
            >
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        )}
        {!editing && !activeModel && <p className="text-xs text-muted-foreground">{t('manualValidation.model.none')}</p>}
        {!editing && activeModel && !fingerprint && <p className="text-xs text-muted-foreground">{t('manualValidation.model.noIdentity')}</p>}
        {saveError && <p role="alert" className="text-xs text-red-600">{saveErrorMessage}</p>}

        <Button type="button" variant="outline" size="sm" className="h-7 w-fit text-xs" onClick={() => {
          const scope = activeModel ? reportModelScope(activeModel.name, activeModel.id, fingerprint) : null;
          useViewerStore.getState().saveValidationReport({
            ...manualReportBlockFromChecklist({ checklist, answers, modelName: scope?.name, modelFingerprint: fingerprint }, 'run'),
            reportModels: scope ? [scope] : [],
          });
        }}>{t('validationPanel.history.saveManual')}</Button>

        {checklist.groups.length > 0 && (
          <div className="flex items-center gap-4 rounded-md border border-border p-3" data-testid="manual-overall">
            <ManualValidationRing counts={summary.overall} name={overallName} size={72} />
            <div className="flex-1">
              <div className="mb-1 text-xs font-semibold">{overallName}</div>
              <ManualValidationLegend counts={summary.overall} />
            </div>
          </div>
        )}
        {checklist.groups.length === 0 && <p className="text-xs text-muted-foreground">{t('manualValidation.empty')}</p>}

        {checklist.groups.map((group, index) => (
          <ManualValidationGroup
            key={group.id}
            group={group}
            counts={summary.groups.get(group.id) ?? EMPTY_MANUAL_COUNTS}
            answers={answers}
            editing={editing}
            isFirst={index === 0}
            isLast={index === checklist.groups.length - 1}
            fingerprint={fingerprint}
          />
        ))}

        {editing && (
          <Button type="button" size="sm" variant="outline" className="h-8 w-fit gap-1.5" onClick={() => addGroup(t('manualValidation.group.defaultName'))}>
            <Plus className="h-3.5 w-3.5" />
            {t('manualValidation.group.add')}
          </Button>
        )}
      </div>
    </div>
  );
}
