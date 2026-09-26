/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Spinner } from '@/components/ui/spinner';


import { Progress } from '@/components/ui/progress';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export function BulkExecutionProgress({ done, total }: { done: number; total: number }) {
  const { t, locale } = useTranslation();
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const safeDone = Number.isFinite(done) ? Math.max(0, Math.min(safeTotal, done)) : 0;
  const percentage = safeTotal > 0 ? (safeDone / safeTotal) * 100 : 0;
  return <div className="space-y-2">
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span className="flex items-center gap-2"><Spinner size="md" />{t('bulkPropertyEditor.applying')}</span>
      <span>{t('bulkPropertyEditor.progress', {
        count: safeTotal,
        done: formatLocaleNumber(locale, safeDone),
        total: formatLocaleNumber(locale, safeTotal),
      })}</span>
    </div>
    <Progress value={percentage} />
  </div>;
}
