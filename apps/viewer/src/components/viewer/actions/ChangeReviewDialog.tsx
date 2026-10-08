/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review dialog for changes converted from an existing editing workflow
 * (P15: CSV import, Bulk editor, IDS correction): what was skipped and why,
 * then every part in the shared `ModelChangeReview` card. Nothing is written
 * until a part is applied there.
 */

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n';
import { MODEL_CHANGE_SET_LIMIT, type ChangeConversion, type ConversionIssue } from '@/lib/actions/change-conversion';
import { ModelChangeReview } from './ModelChangeReview';

const SHOWN_ISSUES = 100;
const REFUSAL = { 'model-unavailable': 'tableChanges.refusedModel', 'tag-scan-limit': 'tableChanges.refusedTagScan',
  'invalid-mapping': 'tableChanges.refusedMapping' } as const satisfies Record<NonNullable<ChangeConversion['refusal']>, string>;

function Issue({ issue }: { issue: ConversionIssue }) {
  const { t } = useTranslation();
  const where = [issue.row !== undefined ? t('tableChanges.issueRow', { row: issue.row }) : null, issue.column, issue.element]
    .filter(Boolean).join(' · ');
  return <li className="break-words">
    <span className="font-medium">{t(`tableChanges.issue.${issue.kind}`)}</span>
    {where && <span className="text-muted-foreground"> — {where}</span>}
    {issue.detail && <span className="text-muted-foreground"> ({issue.detail})</span>}
  </li>;
}

export function ConversionSummary({ conversion }: { conversion: ChangeConversion }) {
  const { t } = useTranslation();
  const { issues } = conversion;
  return <div className="space-y-2 text-xs">
    <p>{t('tableChanges.summary', { count: conversion.total, parts: conversion.batches.length, unchanged: conversion.unchanged, issues: issues.length })}</p>
    {conversion.refused && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">
      {t('tableChanges.refused', { total: conversion.total, limit: MODEL_CHANGE_SET_LIMIT })}</p>}
    {conversion.refusal && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">
      {t(REFUSAL[conversion.refusal])}</p>}
    {!conversion.refused && !conversion.refusal && conversion.total === 0 && <p className="text-muted-foreground">{t('tableChanges.nothing')}</p>}
    {issues.length > 0 && <details>
      <summary className="cursor-pointer font-medium">{t('tableChanges.issuesTitle', { count: issues.length })}</summary>
      <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
        {issues.slice(0, SHOWN_ISSUES).map((issue, index) => <Issue key={index} issue={issue} />)}
      </ul>
      {issues.length > SHOWN_ISSUES && <p className="text-muted-foreground">{t('tableChanges.issuesMore', { count: issues.length - SHOWN_ISSUES })}</p>}
    </details>}
  </div>;
}

/** Open while `conversion` is set. `origin` is recorded on every receipt, suffixed by part. */
export function ChangeReviewDialog({ conversion, origin, onClose }: { conversion: ChangeConversion | null; origin: string; onClose: () => void }) {
  const { t } = useTranslation();
  return <Dialog open={conversion !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col gap-3">
      <DialogHeader>
        <DialogTitle>{t('tableChanges.dialogTitle')}</DialogTitle>
        <DialogDescription>{t('tableChanges.dialogDescription')}</DialogDescription>
      </DialogHeader>
      {conversion && <div className="min-h-0 flex-1 overflow-y-auto space-y-2">
        <ConversionSummary conversion={conversion} />
        {conversion.batches.map((batch, index) => <ModelChangeReview key={`${origin}:${index}`} batch={batch}
          origin={conversion.batches.length > 1 ? `${origin}:part-${index + 1}` : origin} />)}
      </div>}
    </DialogContent>
  </Dialog>;
}
