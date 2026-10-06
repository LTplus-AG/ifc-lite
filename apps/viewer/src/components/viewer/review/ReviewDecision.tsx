/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { HUMAN_STATUSES, REVIEW_LIMITS, saveCardDecision, type CardDecision, type HumanStatus } from '@/lib/review/workspace';
import { HUMAN_STATUS_KEY } from './review-labels';

/** The person's own status and comment for one card; never an analysis result. */
export function ReviewDecision({ cardKey, decision }: { cardKey: string; decision: CardDecision | null }) {
  const { t, locale } = useTranslation();
  const [status, setStatus] = useState<HumanStatus>(decision?.status ?? 'open');
  const [comment, setComment] = useState(decision?.comment ?? '');
  const save = async (next: { status: HumanStatus; comment: string } | null) => {
    const saved = await saveCardDecision(cardKey, next);
    if (saved) toast.success(t(next ? 'reviewWorkspace.decision.saved' : 'reviewWorkspace.decision.cleared'));
    else toast.error(t('reviewWorkspace.decision.unsaved'));
  };
  const selectId = useId();
  return (
    <section aria-label={t('reviewWorkspace.decision.heading')} className="space-y-1.5 rounded border border-border p-2">
      <h4 className="text-xs font-medium">{t('reviewWorkspace.decision.heading')}</h4>
      <p className="text-2xs text-muted-foreground">{t('reviewWorkspace.decision.note')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={selectId} className="text-2xs text-muted-foreground">{t('reviewWorkspace.decision.status')}</label>
        <select id={selectId} value={status} onChange={event => setStatus(event.target.value as HumanStatus)}
          className="h-7 rounded border border-border bg-background px-1.5 text-xs">
          {HUMAN_STATUSES.map(value => <option key={value} value={value}>{t(HUMAN_STATUS_KEY[value])}</option>)}
        </select>
      </div>
      <Field label={t('reviewWorkspace.decision.comment')}>
        <Textarea rows={2} maxLength={REVIEW_LIMITS.comment} value={comment} onChange={event => setComment(event.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void save({ status, comment })}>{t('reviewWorkspace.decision.save')}</Button>
        {decision && <Button size="sm" variant="ghost" onClick={() => { setStatus('open'); setComment(''); void save(null); }}>{t('reviewWorkspace.decision.clear')}</Button>}
        {decision && <span className="text-2xs text-muted-foreground">
          {t('reviewWorkspace.decision.updated', { time: new Date(decision.updatedAt).toLocaleString(locale) })}</span>}
      </div>
    </section>
  );
}
