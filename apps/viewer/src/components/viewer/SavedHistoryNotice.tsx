/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation, type TranslationKey } from '@/i18n';
import type { SavedHistoryIssue } from '@/lib/storage/saved-history';
import { Button } from '@/components/ui/button';

const ISSUE_KEY = {
  recovered: 'validationPanel.history.recovered',
  blocked: 'validationPanel.history.blocked',
  unavailable: 'validationPanel.history.unavailable',
} as const satisfies Record<SavedHistoryIssue, TranslationKey>;

/** One recovery contract for validation and comparison report libraries.
 * Retry saves current in-memory evidence; it must never reload over edits. */
export function SavedHistoryNotice({ issue, subject, onRetry }: {
  issue: SavedHistoryIssue | null;
  subject: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  if (!issue) return null;
  return <div role="alert" className="flex flex-col gap-1 px-2 py-1 text-xs text-destructive" data-saved-history-issue={issue}>
    <p>{t(ISSUE_KEY[issue], { subject })}</p>
    {issue !== 'recovered' && onRetry && <Button type="button" variant="outline" size="sm" className="h-7 w-fit text-xs" onClick={onRetry}>{t('validationPanel.history.retrySave')}</Button>}
  </div>;
}
