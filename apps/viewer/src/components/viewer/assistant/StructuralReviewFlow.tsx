/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import { loadStructuralWrites } from '@/sdk/adapters/store-adapter-structural';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import { ReceiptSummary } from '../actions/ModelChangeReview';

/**
 * The structural review step, shared by a supplied analytical graph and a
 * derived one: load the structural write path, prepare a review, mark it stale
 * when the model changes, apply it once after acknowledgement, keep a receipt.
 */
export function useStructuralReview<R extends { validate(): void }>(label: string) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [review, setReview] = useState<R | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [receipt, setReceipt] = useState<ModelChangeReceipt | null>(null);
  const [receiptProblem, setReceiptProblem] = useState(false);
  const [writes, setWrites] = useState<'loading' | 'ready' | 'failed'>('loading');
  const owner = useRef({ review: null as R | null, committing: false, mounted: true });
  useEffect(() => {
    const current = owner.current;
    current.mounted = true;
    const unsubscribe = useViewerStore.subscribe(() => {
      if (!current.review || current.committing) return;
      try { current.review.validate(); }
      catch (error) {
        console.warn(`[${label}] review became stale`, error);
        setStale(true);
      }
    });
    return () => { current.mounted = false; current.review = null; unsubscribe(); };
  }, [label]);
  const refuse = (error: unknown) => {
    owner.current.review = null; setReview(null); setProblem(error instanceof Error ? error.message : String(error));
  };
  // The structural builders load in their own chunk (#9668). Prepare stays disabled until it has
  // loaded, so the review is never refused for loading; a failed load turns Prepare into a retry.
  const loadWrites = () => {
    setWrites('loading');
    loadStructuralWrites().then(() => { if (owner.current.mounted) { setWrites('ready'); setProblem(null); } }, (error: unknown) => {
      console.warn(`[${label}] structural write path failed to load`, error);
      if (owner.current.mounted) { setWrites('failed'); refuse(error); }
    });
  };
  useEffect(loadWrites, []);
  const prepare = (build: () => R) => {
    try {
      const next = build();
      owner.current.review = next; setReview(next); setProblem(null); setStale(false);
    } catch (error) {
      console.warn(`[${label}] review refused`, error);
      refuse(error);
    }
  };
  const apply = (commit: (review: R) => ModelChangeReceipt) => {
    if (!owner.current.mounted || owner.current.review !== review || !review || stale || receipt || !acknowledged) return;
    try {
      owner.current.committing = true;
      const result = commit(review);
      owner.current.review = null; setReceipt(result); setProblem(null);
      void modelChangeLibrary.put(result.id, result).then(saved => {
        if (owner.current.mounted) setReceiptProblem(!saved);
      }).catch(error => {
        console.warn(`[${label}] receipt could not be stored`, error);
        if (owner.current.mounted) setReceiptProblem(true);
      });
    } catch (error) {
      console.warn(`[${label}] apply refused`, error);
      setProblem(error instanceof Error ? error.message : String(error)); setStale(true);
    } finally { owner.current.committing = false; }
  };
  return { acknowledged, setAcknowledged, review, problem, stale, receipt, receiptProblem, writes, loadWrites, prepare, apply };
}

/**
 * Acknowledgement, Prepare, the prepared review's details, Apply, and the
 * outcome. `build` prepares a review (absent: nothing to prepare); `commit`
 * applies it and returns the receipt.
 */
export function StructuralReviewControls<R extends { validate(): void }>({ flow, acknowledgement, prepareLabel, build, details, applyCount, canApply, commit }: {
  flow: ReturnType<typeof useStructuralReview<R>>; acknowledgement: string; prepareLabel: string; build: (() => R) | undefined;
  details: ReactNode; applyCount: number; canApply: boolean; commit: (review: R) => ModelChangeReceipt;
}) {
  const { t } = useTranslation();
  const { acknowledged, setAcknowledged, review, problem, stale, receipt, receiptProblem, writes, loadWrites } = flow;
  return <>
    {!receipt && <label className="flex items-center gap-2"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{acknowledgement}</label>}
    {!receipt && <Button size="sm" variant="outline" disabled={!build || writes === 'loading'} onClick={() => writes === 'ready' ? build && flow.prepare(build) : loadWrites()}>{prepareLabel}</Button>}
    {review && <>
      {details}
      {!receipt && <Button size="sm" disabled={stale || !canApply || !acknowledged} onClick={() => flow.apply(commit)}>{t('modelChanges.apply', { count: applyCount })}</Button>}
    </>}
    {stale && !receipt && <p role="alert">{t('modelChanges.refused.stale')}</p>}
    {problem && <p role="alert">{problem}</p>}
    {receipt && <ReceiptSummary receipt={receipt} />}
    {receiptProblem && <p role="alert">{t('structuralReview.receiptProblem')}</p>}
  </>;
}
