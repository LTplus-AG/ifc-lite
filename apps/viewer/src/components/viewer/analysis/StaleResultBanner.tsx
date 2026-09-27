/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';

interface StaleResultBannerProps {
  onRerun: () => void;
  disabled?: boolean;
}

export function StaleResultBanner({ onRerun, disabled = false }: StaleResultBannerProps) {
  const { t } = useTranslation();
  return (
    <output className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
      <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <span className="min-w-0 flex-1">{t('analysisStale.message')}</span>
      <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1" disabled={disabled} onClick={onRerun}>
        <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        {t('analysisStale.rerun')}
      </Button>
    </output>
  );
}
