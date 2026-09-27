/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AlertCircle, X } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';

/**
 * Surfaces the BCF slice's `bcfLoading` / `bcfError` under the panel header.
 * BCFPanel's import/export handlers set both, but nothing rendered them, so a
 * corrupt `.bcfzip` or a failed export looked like nothing happened (#5600).
 */
export function BCFPanelStatus() {
  const { t } = useTranslation();
  const bcfLoading = useViewerStore((s) => s.bcfLoading);
  const bcfError = useViewerStore((s) => s.bcfError);
  const setBcfError = useViewerStore((s) => s.setBcfError);

  if (bcfLoading) {
    return (
      <div role="status" className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <Spinner size="sm" />
        {t('bcf.panel.busy')}
      </div>
    );
  }
  if (!bcfError) return null;
  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0 pr-10">
      {/* Before the icon: the Alert pads every sibling after its svg. */}
      <IconButton
        label={t('bcf.panel.dismissError')}
        className="absolute right-2 top-1.5 h-6 w-6"
        onClick={() => setBcfError(null)}
      >
        <X className="h-3.5 w-3.5" />
      </IconButton>
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      <AlertDescription className="wrap-anywhere">{bcfError}</AlertDescription>
    </Alert>
  );
}
