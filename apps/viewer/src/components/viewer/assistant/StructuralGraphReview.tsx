/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import type { StructuralProposal } from '@/lib/actions/structural-graph-proposal';
import { prepareStructuralReview, type StructuralReview } from '@/lib/actions/structural-graph-review';
import { commitReviewedStructural } from '@/lib/actions/structural-graph-receipt';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import { ReceiptSummary } from '../actions/ModelChangeReview';

/** Explicit review and selective approval; analytical data never enters a geometry workplane or ghost. */
export function StructuralGraphReview({ proposal, origin }: { proposal: StructuralProposal; origin: string }) {
  const { t } = useTranslation();
  const [acknowledged, setAcknowledged] = useState(false);
  const [approved, setApproved] = useState(() => new Set(proposal.operations.map((_, index) => index)));
  const [review, setReview] = useState<StructuralReview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [receipt, setReceipt] = useState<ModelChangeReceipt | null>(null);
  const [receiptProblem, setReceiptProblem] = useState(false);
  const owner = useRef({ review: null as StructuralReview | null, committing: false, mounted: true });
  useEffect(() => {
    const current = owner.current;
    current.mounted = true;
    const unsubscribe = useViewerStore.subscribe(() => {
      if (!current.review || current.committing) return;
      try { current.review.validate(); }
      catch (error) {
        console.warn('[Assistant] Native Structural review became stale', error);
        setStale(true);
      }
    });
    return () => { current.mounted = false; current.review = null; unsubscribe(); };
  }, [proposal]);
  const prepare = (selection = approved) => {
    try {
      const next = prepareStructuralReview(useViewerStore, proposal, selection);
      owner.current.review = next; setReview(next); setProblem(null); setStale(false);
    } catch (error) {
      console.warn('[Assistant] Native Structural review refused', error);
      owner.current.review = null; setReview(null); setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  const apply = () => {
    if (!owner.current.mounted || owner.current.review !== review || !review || stale || receipt || !acknowledged) return;
    try {
      owner.current.committing = true;
      const result = commitReviewedStructural(useViewerStore, review, origin);
      owner.current.review = null; setReceipt(result); setProblem(null);
      void modelChangeLibrary.put(result.id, result).then(saved => {
        if (owner.current.mounted) setReceiptProblem(!saved);
      }).catch(error => {
        console.warn('[Assistant] Structural receipt could not be stored', error);
        if (owner.current.mounted) setReceiptProblem(true);
      });
    } catch (error) {
      console.warn('[Assistant] Approved native Structural graph refused', error);
      setProblem(error instanceof Error ? error.message : String(error)); setStale(true);
    } finally { owner.current.committing = false; }
  };
  const delta = review?.delta ?? [];
  return <section aria-label={t('structuralReview.title')} className="mx-3 my-2 rounded border border-border p-3 text-xs space-y-2">
    <h3 className="font-medium">{proposal.title}</h3>
    <p>{t('structuralReview.hint')}</p>
    <p>{t('structuralReview.previewUnavailable')}</p>
    <ul className="space-y-2 max-h-64 overflow-auto">
      {proposal.operations.map((operation, index) => <li key={index}>
        <label className="flex items-center gap-2"><input type="checkbox" checked={approved.has(index)} disabled={!!receipt}
          onChange={event => {
            const next = new Set(approved);
            if (event.target.checked) next.add(index); else next.delete(index);
            setApproved(next); if (review) prepare(next);
          }} />{t(`structuralReview.op.${operation.op}`)}</label>
        {operation.params && <pre className="whitespace-pre-wrap break-words text-muted-foreground">{JSON.stringify(operation.params, null, 2)}</pre>}
        {operation.target !== undefined && <p className="text-muted-foreground">{t('structuralReview.references', { target: JSON.stringify(operation.target), related: JSON.stringify(operation.related ?? []) })}</p>}
      </li>)}
    </ul>
    {!receipt && <label className="flex items-center gap-2"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{t('structuralReview.acknowledgement')}</label>}
    {!receipt && <Button size="sm" variant="outline" disabled={!approved.size} onClick={() => prepare()}>{t('structuralReview.prepare')}</Button>}
    {review && <>
      <output className="block">{t('structuralReview.population', { records: review.snapshot.records.length,
        created: delta.filter(row => !row.before).length, modified: delta.filter(row => row.before && row.after).length, deleted: delta.filter(row => !row.after).length })}</output>
      <details><summary>{t('structuralReview.nativeChanges')}</summary><ul className="space-y-2 max-h-64 overflow-auto">
        {delta.map(row => <li key={row.expressId}><p>{row.after?.type ?? row.before?.type} #{row.expressId}</p>
          <pre className="whitespace-pre-wrap break-words">{JSON.stringify(row.before?.attributes ?? null)}{' → '}{JSON.stringify(row.after?.attributes ?? null)}</pre></li>)}
      </ul></details>
      {!receipt && <Button size="sm" disabled={stale || !approved.size || !acknowledged} onClick={apply}>{t('modelChanges.apply', { count: approved.size })}</Button>}
    </>}
    {stale && !receipt && <p role="alert">{t('modelChanges.refused.stale')}</p>}
    {problem && <p role="alert">{problem}</p>}
    {receipt && <ReceiptSummary receipt={receipt} />}
    {receiptProblem && <p role="alert">{t('structuralReview.receiptProblem')}</p>}
  </section>;
}
