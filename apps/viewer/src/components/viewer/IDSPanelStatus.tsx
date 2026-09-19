/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export function StatusIcon({ status, showLabel = false }: { status: 'pass' | 'fail' | 'not_applicable'; showLabel?: boolean }) {
  const { t } = useTranslation();
  const labels: Record<typeof status, TranslationKey> = {
    pass: 'idsPanel.status.passed',
    fail: 'idsPanel.status.failed',
    not_applicable: 'idsPanel.status.notApplicable',
  };

  const icons = {
    pass: <CheckCircle className="h-4 w-4 text-green-500" aria-hidden="true" />,
    fail: <XCircle className="h-4 w-4 text-red-500" aria-hidden="true" />,
    not_applicable: <AlertCircle className="h-4 w-4 text-yellow-500" aria-hidden="true" />,
  };

  return (
    <span className="inline-flex items-center gap-1" role="status" aria-label={t(labels[status])}>
      {icons[status]}
      {showLabel && <span className="sr-only">{t(labels[status])}</span>}
    </span>
  );
}

export function PassRateBar({ passRate }: { passRate: number }) {
  const { locale } = useTranslation();
  const color = passRate >= 80 ? 'bg-green-500' : passRate >= 50 ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', color)}
          style={{ width: `${passRate}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground w-10 text-right">
        {formatLocaleNumber(locale, passRate / 100, { style: 'percent', maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}
