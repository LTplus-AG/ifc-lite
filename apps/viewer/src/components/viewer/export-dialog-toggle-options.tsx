/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExportDialog.tsx` (#5848 shell migration): the visible-only / include-
 * geometry / apply-mutations / changes-only / only-known-properties toggles,
 * plus the "pending changes" stats banner — extracted verbatim, purely
 * presentational. Every gating condition and every piece of state still lives
 * in `ExportDialog.tsx`.
 */

import { AlertCircle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTranslation } from '@/i18n';

type ExportScope = 'single' | 'merged';

export interface ExportDialogToggleOptionsProps {
  visibleOnly: boolean;
  setVisibleOnly: (v: boolean) => void;
  changesOnly: boolean;
  setChangesOnly: (v: boolean) => void;
  exportScope: ExportScope;
  includeGeometry: boolean;
  setIncludeGeometry: (v: boolean) => void;
  applyMutations: boolean;
  setApplyMutations: (v: boolean) => void;
  isIfc5: boolean;
  hasFilterableProperties: boolean;
  onlyKnownProperties: boolean;
  setOnlyKnownProperties: (v: boolean) => void;
  modifiedCount: number;
}

/** The dialog's toggle switches and the pending-changes stats banner. */
export function ExportDialogToggleOptions({
  visibleOnly,
  setVisibleOnly,
  changesOnly,
  setChangesOnly,
  exportScope,
  includeGeometry,
  setIncludeGeometry,
  applyMutations,
  setApplyMutations,
  isIfc5,
  hasFilterableProperties,
  onlyKnownProperties,
  setOnlyKnownProperties,
  modifiedCount,
}: ExportDialogToggleOptionsProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <Label>{t('exportDialog.visibleOnlyLabel')}</Label>
          <p className="text-xs text-muted-foreground">{t('exportDialog.visibleOnlyHint')}</p>
        </div>
        <Switch checked={visibleOnly} onCheckedChange={setVisibleOnly} />
      </div>

      {!changesOnly && exportScope === 'single' && (
        <div className="flex items-center justify-between">
          <Label>{t('exportDialog.includeGeometryLabel')}</Label>
          <Switch checked={includeGeometry} onCheckedChange={setIncludeGeometry} />
        </div>
      )}

      {(exportScope === 'single' || exportScope === 'merged') && (
        <div className="flex items-center justify-between">
          <Label>{t('exportDialog.applyMutationsLabel')}</Label>
          <Switch checked={applyMutations} onCheckedChange={setApplyMutations} />
        </div>
      )}

      {exportScope === 'single' && (
        <div className="flex items-center justify-between">
          <div>
            <Label>{isIfc5 ? t('exportDialog.changesOnlyLabel.ifc5') : t('exportDialog.changesOnlyLabel.default')}</Label>
            <p className="text-xs text-muted-foreground">
              {isIfc5 ? t('exportDialog.changesOnlyHint.ifc5') : t('exportDialog.changesOnlyHint.default')}
            </p>
          </div>
          <Switch checked={changesOnly} onCheckedChange={setChangesOnly} />
        </div>
      )}

      {/* IFC5: strict property schema filtering */}
      {isIfc5 && hasFilterableProperties && (
        <div className="flex items-center justify-between">
          <div>
            <Label>{t('exportDialog.onlyKnownPropertiesLabel')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('exportDialog.onlyKnownPropertiesHint')}
            </p>
          </div>
          <Switch checked={onlyKnownProperties} onCheckedChange={setOnlyKnownProperties} />
        </div>
      )}

      {/* Stats */}
      {modifiedCount > 0 && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('exportDialog.pendingChangesTitle')}</AlertTitle>
          <AlertDescription>
            {t('exportDialog.pendingChangesDescription', { count: modifiedCount, countDisplay: modifiedCount })}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
