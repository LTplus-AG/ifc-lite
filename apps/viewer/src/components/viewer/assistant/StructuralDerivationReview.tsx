/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import { commitStructuralDerivation, derivationModelId, prepareStructuralDerivationReview, type StructuralDerivationReview as Review } from '@/lib/actions/structural-derive-review';
import { StructuralReviewControls, useStructuralReview } from './StructuralReviewFlow';

/** Rows a list renders; real models skip or leave unconnected hundreds of items. */
const SHOWN = 100;
const metres = (p: readonly number[]) => p.map((v) => v.toFixed(2)).join(', ');

function Listing<T>({ summary, rows, row }: { summary: string; rows: readonly T[]; row: (item: T) => ReactNode }) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return <details><summary>{summary}</summary>
    <ul className="space-y-1 max-h-48 overflow-auto">{rows.slice(0, SHOWN).map((item, index) => <li key={index}>{row(item)}</li>)}</ul>
    {rows.length > SHOWN && <p className="text-muted-foreground">{t('structuralReview.derive.more', { count: rows.length - SHOWN })}</p>}
  </details>;
}

/** The plan a derivation would write: what it derives, what it skipped and why, and which supports it guessed. */
function DerivationSummary({ review }: { review: Review }) {
  const { t } = useTranslation();
  const { plan } = review;
  const { counts, skipped, unconnectedEnds } = plan.report;
  return <>
    <output className="block">{t('structuralReview.derive.counts', { ...counts, created: review.created })}</output>
    {plan.derivedModelId !== null && <p role="alert">{t('structuralReview.derive.existing', { id: plan.derivedModelId })}</p>}
    {plan.derivedModelId === null && review.created === 0 && <p role="alert">{t('structuralReview.derive.nothing')}</p>}
    {counts.assumedLoadBearing > 0 && <p>{t('structuralReview.derive.assumed', { count: counts.assumedLoadBearing })}</p>}
    <Listing summary={t('structuralReview.derive.skipped', { count: skipped.length })} rows={skipped} row={(item) => <>
      {item.type} #{item.elementId}{item.name ? ` ${item.name}` : ''}: <span className="text-muted-foreground">{item.reason} ({item.detail})</span>
    </>} />
    <Listing summary={t('structuralReview.derive.guessed', { count: counts.guessedSupports })} rows={plan.nodes.filter((node) => node.support?.guessed)}
      row={(node) => t('structuralReview.derive.nodeAt', { node: node.index + 1, position: metres(node.position) })} />
    <Listing summary={t('structuralReview.derive.unconnected', { count: unconnectedEnds.length })} rows={unconnectedEnds}
      row={(end) => t('structuralReview.derive.endAt', { node: end.node + 1, position: metres(plan.nodes[end.node].position), landsOn: end.landsOn, element: end.landsOnElementId })} />
  </>;
}

/** The structural review step for a derived analysis model: derive, review, apply as one edit. */
export function StructuralDerivationReview({ origin }: { origin: string }) {
  const { t } = useTranslation();
  const modelId = useViewerStore(derivationModelId);
  const flow = useStructuralReview<Review>('Structural derivation');
  const { review } = flow;
  const members = review ? review.plan.report.counts.curveMembers + review.plan.report.counts.surfaceMembers : 0;
  return <section aria-label={t('structuralReview.derive.title')} className="text-xs space-y-2">
    <p>{t('structuralReview.derive.hint')}</p>
    {modelId === null && <p role="alert">{t('structuralReview.derive.noModel')}</p>}
    <StructuralReviewControls flow={flow} acknowledgement={t('structuralReview.derive.acknowledgement')} prepareLabel={t('structuralReview.derive.prepare')}
      build={modelId === null ? undefined : () => prepareStructuralDerivationReview(useViewerStore, modelId)}
      applyCount={members} canApply={(review?.created ?? 0) > 0}
      commit={(current) => commitStructuralDerivation(useViewerStore, current, origin)}
      details={review && <DerivationSummary review={review} />} />
  </section>;
}

/** The palette command's dialog; each `session` derives afresh. */
export function StructuralDerivationDialog({ open, onOpenChange, onCloseAutoFocus, session }: {
  open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus: (event: Event) => void; session: number;
}) {
  const { t } = useTranslation();
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent viewportBounds="height" className="max-w-xl overflow-y-auto" aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
      <DialogTitle>{t('structuralReview.derive.title')}</DialogTitle>
      <StructuralDerivationReview key={session} origin={`palette:derive-structural:${session}`} />
    </DialogContent>
  </Dialog>;
}
