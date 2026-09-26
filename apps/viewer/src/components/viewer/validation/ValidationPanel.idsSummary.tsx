/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the last rule set -> IDS export or IDS -> rule set import converted,
 * and every rule / specification it refused with its reasons (#5225). The
 * converter never drops anything silently; this is where the user sees it.
 * The reasons themselves are the converter's runtime text (English), the
 * same posture as an engine error message; the chrome is catalogued.
 */

import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import type { IdsInterchangeSummary } from '@/hooks/validation/useInformationValidation';

export interface IdsSummaryProps {
  summary: IdsInterchangeSummary;
  onDismiss: () => void;
}

export function IdsSummary({ summary, onDismiss }: IdsSummaryProps) {
  const { t } = useTranslation();
  const isExport = summary.direction === 'export';
  const headline = summary.converted === 0
    ? t(isExport ? 'validationPanel.idsExport.none' : 'validationPanel.idsImport.none')
    : t(isExport ? 'validationPanel.idsExport.summary' : 'validationPanel.idsImport.summary', {
      converted: summary.converted,
      total: summary.total,
    });

  return (
    // The dismissible summary contains block content and a button, so output is not valid here.
    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
    <div className="mx-3 mb-2 rounded border border-border bg-muted/40 p-2 text-xs" role="status" data-testid="ids-interchange-summary">
      <div className="flex items-start gap-2">
        <p className="flex-1 font-medium">{headline}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0"
          aria-label={t('validationPanel.idsSummary.dismiss')}
          onClick={onDismiss}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      {summary.refused.length > 0 && (
        <div className="mt-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t(isExport ? 'validationPanel.idsExport.refusedHeading' : 'validationPanel.idsImport.refusedHeading')}
          </h4>
          <ul className="mt-1 flex flex-col gap-1">
            {summary.refused.map((item, i) => (
              <li key={`${item.name}-${i}`}>
                <span className="font-medium">{item.name}</span>
                <ul className="ml-3 list-disc text-muted-foreground">
                  {item.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.dropped && summary.dropped.length > 0 && (
        <div className="mt-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('validationPanel.idsImport.droppedHeading')}
          </h4>
          <ul className="ml-3 mt-1 list-disc text-muted-foreground">
            {summary.dropped.map((item, i) => <li key={`${item}-${i}`}>{item}</li>)}
          </ul>
        </div>
      )}
      {summary.notes.length > 0 && (
        <div className="mt-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('validationPanel.idsSummary.notesHeading')}
          </h4>
          <ul className="ml-3 mt-1 list-disc text-muted-foreground">
            {summary.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
