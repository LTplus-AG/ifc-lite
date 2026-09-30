/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { SavedHistoryNotice } from '../SavedHistoryNotice';

export function SavedComparisonHistoryNotice() {
  const { t } = useTranslation();
  const issue = useViewerStore((s) => s.savedComparisonsLoadIssue);
  const retry = useViewerStore((s) => s.retrySaveComparisons);
  return <SavedHistoryNotice issue={issue} subject={t('comparePanel.saved.title')} onRetry={retry} />;
}
