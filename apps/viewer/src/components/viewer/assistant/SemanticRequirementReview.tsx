/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import type { ExtractedRequirement, SemanticRequirementProposal } from '@/lib/semantic/assist/requirement-proposal';
import { reviewRequirements } from '@/lib/semantic/assist/requirement-review';
import { saveSemanticReview, semanticReviewLibrary, useSemanticReviews } from '@/lib/semantic/assist/library';
import type { Passage } from '@/lib/semantic/assist/spans';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { ReviewFrame, SpanQuote } from './SemanticReviewParts';

function structured(requirement: ExtractedRequirement): string {
  const value = Array.isArray(requirement.value) ? requirement.value.join(', ') : requirement.value;
  return [requirement.appliesTo?.ifcClass, requirement.appliesTo?.ontologyClass, requirement.property, requirement.operator,
    value === undefined ? undefined : String(value), requirement.unit].filter(part => part !== undefined).join(' · ');
}

/** Every requirement points at its exact source span; unverified and unsupported items stay visible and are saved as such. */
export function SemanticRequirementReview({ proposal, origin, passages }: { proposal: SemanticRequirementProposal; origin: string; passages: readonly Passage[] }) {
  const { t } = useTranslation();
  const review = useMemo(() => reviewRequirements(proposal, passages), [proposal, passages]);
  const status = useSemanticReviews(s => s.status);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      setSaved(await saveSemanticReview({ version: 1, id: crypto.randomUUID(), type: 'requirements', createdAt: new Date().toISOString(), origin, proposal,
        spans: review.requirements.map(row => row.check.status), unsupportedSpans: review.unsupported.map(row => row.check?.status ?? null) }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <ReviewFrame label={t('semanticAssist.requirementsTitle')} title={proposal.title}>
    <p className="text-muted-foreground">{t('semanticAssist.requirementsVerified', { verified: review.verified, count: review.requirements.length })}</p>
    {!passages.length && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('semanticAssist.requirementsNoSources')}</p>}
    <ol className="space-y-2">{review.requirements.map(({ requirement, check }) => <li key={requirement.id} className="rounded border border-border p-1.5 space-y-1">
      <p><span className="font-mono font-semibold">{requirement.id}</span> {requirement.statement}</p>
      {structured(requirement) && <p className="font-mono text-2xs text-muted-foreground break-all">{structured(requirement)}</p>}
      <SpanQuote span={requirement.span} check={check} />
    </li>)}</ol>
    {review.unsupported.length > 0 && <div className="space-y-1">
      <p className="font-medium">{t('semanticAssist.unsupported')}</p>
      <ol className="space-y-2">{review.unsupported.map(({ item, check }, index) => <li key={index} className="rounded border border-dashed border-border p-1.5 space-y-1">
        <p className="break-words">{item.text}</p>
        <p className="text-muted-foreground break-words">{t('semanticAssist.unsupportedReason', { reason: item.reason })}</p>
        {item.span && check && <SpanQuote span={item.span} check={check} />}
      </li>)}</ol>
    </div>}
    <Button size="sm" className="h-7" disabled={saved} onClick={() => void save()}>{t('semanticAssist.requirementsSave')}</Button>
    {saved && <p aria-live="polite" className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2">{t('semanticAssist.saved')}</p>}
    {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
    <ContentStorageNotice status={status} retry={semanticReviewLibrary.retry} restore={semanticReviewLibrary.restore} />
  </ReviewFrame>;
}
