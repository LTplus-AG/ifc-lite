/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ValidationReport } from '@ifc-lite/semantic';
import { useTranslation } from '@/i18n';

/** Describe the report actually returned by the worker, never infer its scope from current records. */
export function SemanticValidationSummary({ report }: { report?: ValidationReport }) {
  const { t } = useTranslation();
  if (!report) return <p className="text-sm">{t('semantic.unvalidated')}</p>;
  return <div aria-label={t('semantic.validation')}>
    <p className="text-xs break-all">{report.profile.id} · {report.profile.version} · {t(`semantic.validationScope.${report.scope}`)} · {t(report.completeness === 'complete' ? 'semantic.complete' : 'semantic.partial')} · {report.engines.join(' / ')}</p>
    <p className="text-xs">{t('semantic.validationReportLimits', report.limits)}</p>
    {report.truncated && <p className="text-sm">{t('semantic.validationTruncated')}</p>}
    <p className="text-sm">{t(report.conforms && !report.truncated ? 'semantic.valid' : 'semantic.validationDoesNotConform')}</p>
  </div>;
}
