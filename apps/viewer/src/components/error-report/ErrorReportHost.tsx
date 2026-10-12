/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { pendingReport } from '@/lib/error-reports/pending';
import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from '@/i18n';
import { dismissErrorReport, getReportPrompt, offerErrorReport, openErrorReport, subscribeReportPrompt } from '@/lib/error-reports/context';
const ErrorReportDialog = lazy(() => import('./ErrorReportDialog').then(module => ({ default: module.ErrorReportDialog })));
/** Independent of renderer/store: remains usable when the viewport failed. */
export function ErrorReportHost() {
  const prompt = useSyncExternalStore(subscribeReportPrompt, getReportPrompt, () => null);
  const { t } = useTranslation();
  useEffect(() => {
    const resumeReportId = pendingReport();
    if (resumeReportId) offerErrorReport({ errorCode: 'report_resume', resumeReportId });
    const onError = () => offerErrorReport({ errorCode: 'unhandled_viewer_error' });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onError);
    };
  }, []);
  if (!prompt) return null;
  if (prompt.open) return <Suspense fallback={<output>{t('errorReport.loading')}</output>}>
    <ErrorReportDialog context={prompt.context} onClose={dismissErrorReport} />
  </Suspense>;
  return <aside aria-label={t('errorReport.invite')} className="fixed bottom-12 right-4 z-50 max-w-sm rounded-lg border bg-background p-4 shadow-lg">
    <p className="text-sm font-medium">{t('errorReport.invite')}</p>
    <p className="my-2 text-xs text-muted-foreground">{t('errorReport.intro')}</p>
    <button type="button" className="mr-3 rounded border px-3 py-1 text-sm" onClick={openErrorReport}>{t('errorReport.open')}</button>
    <button type="button" className="text-sm" onClick={dismissErrorReport}>{t('errorReport.dismiss')}</button>
  </aside>;
}
