/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS → BCF dialog's topic count, and a warning when the chosen grouping
 * would exceed the topic cap (#5824). Before this, the dialog defaulted to one
 * topic per failing entity and said nothing until the file arrived with
 * 1,000 topics and a "truncated" note.
 */

import { AlertTriangle } from 'lucide-react';
import type { IDSReportInput } from '@ifc-lite/bcf';
import { formatLocaleNumber, useTranslation } from '@/i18n';
import { estimateIdsBcfTopicCount, IDS_BCF_MAX_TOPICS, type IdsBcfTopicEstimateInput } from '@/lib/ids/bcf-topic-estimate';

interface IDSExportTopicCountProps {
  specificationResults: IDSReportInput['specificationResults'];
  settings: IdsBcfTopicEstimateInput;
}

export function IDSExportTopicCount({ specificationResults, settings }: IDSExportTopicCountProps) {
  const { t, locale } = useTranslation();
  const count = estimateIdsBcfTopicCount({ specificationResults }, settings);
  const countDisplay = formatLocaleNumber(locale, count);
  if (count <= IDS_BCF_MAX_TOPICS) {
    return <p className="text-xs text-muted-foreground">{t('idsPanel.export.topicCount', { count, countDisplay })}</p>;
  }
  return (
    <p role="alert" className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>
        {t('idsPanel.export.topicCapWarning', {
          countDisplay,
          capDisplay: formatLocaleNumber(locale, IDS_BCF_MAX_TOPICS),
          omittedDisplay: formatLocaleNumber(locale, count - IDS_BCF_MAX_TOPICS),
        })}
      </span>
    </p>
  );
}
