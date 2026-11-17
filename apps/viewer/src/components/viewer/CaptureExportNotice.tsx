/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Sparkles } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { omittedCaptureCount } from '@/lib/export/capture-export';

/** Shown by every export dialog while Gaussian captures are loaded: they are left out (#8568). */
export function CaptureExportNotice() {
  const { t, locale } = useTranslation();
  const count = useViewerStore((s) => omittedCaptureCount(s.models));
  if (count === 0) return null;
  return (
    <p role="note" data-testid="capture-export-notice" className="flex items-start gap-2 text-xs text-muted-foreground">
      <Sparkles className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
      {t('gaussianCapture.export.notice', { count, formatted: formatLocaleNumber(locale, count) })}
    </p>
  );
}
