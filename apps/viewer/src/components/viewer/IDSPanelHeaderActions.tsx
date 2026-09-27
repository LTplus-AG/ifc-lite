/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS panel's header actions once a document is loaded (#5816):
 *
 * - **Re-run** repeats the check that produced the report on screen: same IDS
 *   document, same model. The model is the REPORT's, not the active one, so
 *   with N models loaded a re-run cannot silently switch to another model.
 * - **Clear results** drops the report and keeps the document, returning to
 *   the pre-run card.
 * - **Unload IDS** drops both.
 *
 * Before #5816 the only Run button disappeared once a report existed, and the
 * single Trash button unloaded the document too, so re-checking after an edit
 * meant reloading the `.ids` file.
 */

import { Eraser, RotateCw, Square, Trash2, Upload } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';

interface HeaderActionProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}

function HeaderAction({ label, onClick, disabled, children }: HeaderActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={label} onClick={onClick} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

interface IDSPanelHeaderActionsProps {
  /** Model the report on screen was validated against; `null` before the first run. */
  reportModelId: string | null;
  loading: boolean;
  validating: boolean;
  onRerun: (modelId: string) => void;
  onCancel: () => void;
  onLoadNew: () => void;
  onClearResults: () => void;
  onUnload: () => void;
}

export function IDSPanelHeaderActions({
  reportModelId, loading, validating, onRerun, onCancel, onLoadNew, onClearResults, onUnload,
}: IDSPanelHeaderActionsProps) {
  const { t } = useTranslation();
  return (
    <>
      {reportModelId !== null && (
        <HeaderAction label={t(validating ? 'idsPanel.cancel' : 'idsPanel.rerun')} onClick={validating ? onCancel : () => onRerun(reportModelId)} disabled={loading && !validating}>
          {validating ? <Square className="h-3 w-3" /> : loading ? <Spinner size="xs" /> : <RotateCw className="h-3 w-3" />}
        </HeaderAction>
      )}
      <HeaderAction label={t('idsPanel.loadNew')} onClick={onLoadNew}>
        <Upload className="h-3 w-3" />
      </HeaderAction>
      {reportModelId !== null && (
        <HeaderAction label={t('idsPanel.clearResults')} onClick={onClearResults}>
          <Eraser className="h-3 w-3" />
        </HeaderAction>
      )}
      <HeaderAction label={t('idsPanel.unload')} onClick={onUnload}>
        <Trash2 className="h-3 w-3" />
      </HeaderAction>
    </>
  );
}
