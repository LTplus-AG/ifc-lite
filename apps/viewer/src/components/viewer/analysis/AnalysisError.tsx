/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one analysis error surface (#5834), extracted from BCF's #5600 status
 * alert: a destructive alert under the header, dismissable when the panel's
 * error state can be cleared by the user (BCF) and persistent when it clears
 * itself on the next run (IDS, Clash, Compare).
 */

import { AlertCircle, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

export function AnalysisError({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert variant="destructive" className={cn('rounded-none border-x-0 border-t-0 py-2 text-xs [&>svg]:top-2.5', onDismiss && 'pr-10')}>
      {/* Before the icon: the Alert pads every sibling after its svg. */}
      {onDismiss && (
        <IconButton label={t('analysisPanel.dismissError')} className="absolute right-2 top-1.5 h-6 w-6" onClick={onDismiss}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      )}
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      <AlertDescription className="wrap-anywhere">{message}</AlertDescription>
    </Alert>
  );
}
