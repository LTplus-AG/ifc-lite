/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Loader2 } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export function BulkExecutionProgress({ done, total }: { done: number; total: number }) {
  const { t, locale } = useTranslation();
  return <div className="space-y-2">
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{t('bulkPropertyEditor.applying')}</span>
      <span>{t('bulkPropertyEditor.progress', {
        count: total,
        done: formatLocaleNumber(locale, done),
        total: formatLocaleNumber(locale, total),
      })}</span>
    </div>
    <Progress value={total > 0 ? (done / total) * 100 : 0} />
  </div>;
}
