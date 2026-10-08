/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { useSemanticSession } from '@/lib/semantic/session';
import type { SemanticMappingProposal } from '@/lib/semantic/assist/mapping-proposal';
import { reviewSemanticMapping, type MappingIssue, type TermMatch } from '@/lib/semantic/assist/mapping-review';
import { saveSemanticReview, semanticReviewLibrary, useSemanticReviews } from '@/lib/semantic/assist/library';
import { captureRevisionPin } from '@/lib/semantic/assist/revision-pin';
import type { Passage } from '@/lib/semantic/assist/spans';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { ReviewFrame, SpanQuote } from './SemanticReviewParts';

const ISSUE: Record<MappingIssue, TranslationKey> = {
  'unknown-term': 'semanticAssist.issueUnknownTerm', 'span-mismatch': 'semanticAssist.issueSpanMismatch',
  'span-not-captured': 'semanticAssist.issueSpanNotCaptured', 'external-term': 'semanticAssist.issueExternalTerm',
  'class-absent': 'semanticAssist.issueClassAbsent', unsourced: 'semanticAssist.issueUnsourced',
};

function Term({ match, value }: { match: TermMatch | undefined; value: string | undefined }) {
  const { t } = useTranslation();
  if (!match || value === undefined) return null;
  return <span className="break-all">{value} <span className="text-2xs text-muted-foreground">
    ({match.status === 'profile' ? t('semanticAssist.termProfile', { key: match.key }) : t(match.status === 'external' ? 'semanticAssist.termExternal' : 'semanticAssist.termUnknown')})
  </span></span>;
}

/** Each mapping is checked against the live model scope, the current profile and the captured passages before it can be saved. */
export function SemanticMappingReview({ proposal, origin, passages }: { proposal: SemanticMappingProposal; origin: string; passages: readonly Passage[] }) {
  const { t } = useTranslation();
  const id = useId();
  const profile = useSemanticSession(s => s.profile);
  const revisions = useSemanticSession(s => s.revisions);
  const models = useViewerStore(s => s.models);
  const mutationVersion = useViewerStore(s => s.mutationVersion);
  const status = useSemanticReviews(s => s.status);
  const review = useMemo(() => reviewSemanticMapping(proposal, { profile, revisions, passages }),
    // Model or edit changes re-count classes against the current revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [proposal, profile, revisions, passages, models, mutationVersion]);
  const [approval, setApproval] = useState<{ view: typeof review; indices: ReadonlySet<number> } | null>(null);
  const approved = approval?.view === review ? approval.indices : new Set<number>();
  const [savedReview, setSavedReview] = useState<typeof review | null>(null);
  const saved = savedReview === review;
  const [error, setError] = useState<string | null>(null);
  const chosen = [...approved].filter(index => review.rows[index]?.approvable).sort((a, b) => a - b);
  const save = async () => {
    setError(null);
    try {
      if (await saveSemanticReview({ version: 1, id: crypto.randomUUID(), type: 'mapping', createdAt: new Date().toISOString(), origin,
        profile: { id: profile.id, version: profile.version, identity: JSON.stringify(profile) }, pin: captureRevisionPin(revisions), proposal, approved: chosen })) setSavedReview(review);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <ReviewFrame label={t('semanticAssist.mappingTitle')} title={proposal.title}>
    <p className="text-muted-foreground break-all">{t('semanticAssist.mappingRevision', { revision: proposal.modelRevision })}</p>
    {!review.modelId && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('semanticAssist.mappingUnscoped')}</p>}
    <ol className="space-y-2">{review.rows.map((row, index) => <li key={index} className="rounded border border-border p-1.5 space-y-1">
      <div className="flex items-start gap-2">
        <input id={`${id}-${index}`} type="checkbox" checked={approved.has(index)} disabled={!row.approvable || saved}
          onChange={event => { const next = new Set(approved); if (event.target.checked) next.add(index); else next.delete(index); setApproval({ view: review, indices: next }); }} />
        <div className="min-w-0 space-y-0.5">
          <label htmlFor={`${id}-${index}`} className="block font-mono text-2xs break-all">{[row.mapping.ifc.class, row.mapping.ifc.pset && `${row.mapping.ifc.pset}.${row.mapping.ifc.property}`].filter(Boolean).join(' · ')}</label>
          <span className="block">→ <Term match={row.classTerm} value={row.mapping.ontology.class} /> <Term match={row.propertyTerm} value={row.mapping.ontology.property} /></span>
          <span className="block text-muted-foreground">{t('semanticAssist.mappingConfidence', { percent: Math.round(row.mapping.confidence * 100) })}
            {' · '}{t('semanticAssist.mappingElements', { count: row.elements })}</span>
        </div>
      </div>
      {row.mapping.rationale && <p className="text-muted-foreground break-words">{row.mapping.rationale}</p>}
      {row.spans.map(({ span, check }, spanIndex) => <SpanQuote key={spanIndex} span={span} check={check} />)}
      {row.issues.length > 0 && <ul className="text-2xs text-amber-700 dark:text-amber-400">{row.issues.map(issue => <li key={issue}>{t(ISSUE[issue])}</li>)}</ul>}
    </li>)}</ol>
    {proposal.unsupported.length > 0 && <div><p className="font-medium">{t('semanticAssist.unsupported')}</p>
      <ul className="list-disc pl-4">{proposal.unsupported.map((item, index) => <li key={index} className="break-words">{item.text} — {item.reason}</li>)}</ul></div>}
    <Button size="sm" className="h-7" disabled={!chosen.length || saved} onClick={() => void save()}>{t('semanticAssist.mappingSave', { count: chosen.length })}</Button>
    {saved && <p aria-live="polite" className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2">{t('semanticAssist.saved')}</p>}
    {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
    <ContentStorageNotice status={status} retry={semanticReviewLibrary.retry} restore={semanticReviewLibrary.restore} />
  </ReviewFrame>;
}
