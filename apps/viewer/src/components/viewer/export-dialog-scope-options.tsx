/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExportDialog.tsx` (#5848 shell migration): the scope/unit/model picker
 * section, extracted verbatim so the dialog's own file stays readable once
 * its chrome moves to `ExportDialogShell.tsx`. Purely presentational — every
 * piece of state and every gating condition still lives in `ExportDialog.tsx`
 * and is passed in as props.
 */

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from '@/i18n';
import type { ExportModelListItem } from './export-model-selection';

type ExportScope = 'single' | 'merged';

export interface ExportDialogScopeOptionsProps {
  isIfc5: boolean;
  changesOnly: boolean;
  modelList: readonly ExportModelListItem[];
  exportScope: ExportScope;
  setExportScope: (scope: ExportScope) => void;
  unitReconciliation: 'auto' | 'normalize' | 'assume-shared';
  setUnitReconciliation: (v: 'auto' | 'normalize' | 'assume-shared') => void;
  selectedModelId: string;
  setSelectedModelId: (id: string) => void;
  exportModelLabels: ReadonlyMap<string, string>;
}

/** Scope selector, mixed-unit reconciliation, and the model picker. */
export function ExportDialogScopeOptions({
  isIfc5,
  changesOnly,
  modelList,
  exportScope,
  setExportScope,
  unitReconciliation,
  setUnitReconciliation,
  selectedModelId,
  setSelectedModelId,
  exportModelLabels,
}: ExportDialogScopeOptionsProps) {
  const { t } = useTranslation();

  return (
    <>
      {/* Scope selector (only for STEP schemas with multiple models) */}
      {!isIfc5 && !changesOnly && modelList.length > 1 && (
        <div className="flex items-center gap-4">
          <Label className="w-32">{t('exportDialog.scopeLabel')}</Label>
          <Select value={exportScope} onValueChange={(v) => setExportScope(v as ExportScope)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">{t('exportDialog.scope.single')}</SelectItem>
              <SelectItem value="merged">{t('exportDialog.scope.merged')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Mixed-unit handling — only meaningful for a merged export */}
      {!isIfc5 && !changesOnly && exportScope === 'merged' && modelList.length > 1 && (
        <div className="flex items-center gap-4">
          <Label className="w-32">{t('exportDialog.mixedUnitsLabel')}</Label>
          <Select value={unitReconciliation} onValueChange={(v) => setUnitReconciliation(v as typeof unitReconciliation)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('exportDialog.unitReconciliation.auto')}</SelectItem>
              <SelectItem value="normalize">{t('exportDialog.unitReconciliation.normalize')}</SelectItem>
              <SelectItem value="assume-shared">{t('exportDialog.unitReconciliation.assumeShared')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Model selector (only for single-model export) */}
      {exportScope === 'single' && (
        <div className="flex items-center gap-4">
          <Label className="w-32">{t('exportDialog.modelLabel')}</Label>
          <Select value={selectedModelId} onValueChange={setSelectedModelId}>
            <SelectTrigger>
              <SelectValue placeholder={t('exportDialog.selectModelPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {modelList.map((m) => {
                const displayName = exportModelLabels.get(m.id) ?? m.name;
                return (
                  <SelectItem key={m.id} value={m.id} title={m.name}>
                    {displayName}{m.isDirty ? ' *' : ''}{m.sourceSchema ? ` (${m.sourceSchema})` : m.schemaVersion ? ` (${m.schemaVersion})` : ''}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}
    </>
  );
}
