/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { registerEnglish } from '@/i18n';
import { structuralDeriveEn } from '@/i18n/catalogues/structural-derive.en';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import { commitStructuralDerivation, derivationModelId, prepareStructuralDerivationReview, type StructuralDerivationReview as Review } from '@/lib/actions/structural-derive-review';
import { StructuralReviewControls, useStructuralReview } from './StructuralReviewFlow';

// The review's copy loads with this chunk (#6923), not at first load.
registerEnglish(structuralDeriveEn);

/** Rows a list renders; real models skip or leave unconnected hundreds of items. */
const SHOWN = 100;
const metres = (p: readonly number[]) => p.map((v) => v.toFixed(2)).join(', ');

function Listing<T>({ summary, rows, row }: { summary: string; rows: readonly T[]; row: (item: T) => ReactNode }) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return <details><summary>{summary}</summary>
    <ul className="space-y-1 max-h-48 overflow-auto">{rows.slice(0, SHOWN).map((item, index) => <li key={index}>{row(item)}</li>)}</ul>
    {rows.length > SHOWN && <p className="text-muted-foreground">{t('structuralDerive.more', { count: rows.length - SHOWN })}</p>}
  </details>;
}

/** The plan a derivation would write: what it derives, what it skipped and why, and which supports it guessed. */
function DerivationSummary({ review }: { review: Review }) {
  const { t } = useTranslation();
  const { plan } = review;
  const nodeRow = (index: number) => t('structuralDerive.nodeAt', { node: index + 1, position: metres(plan.nodes[index].position) });
  const { counts, skipped, unconnectedEnds, extendedEnds, freeEnds } = plan.report;
  const existing = plan.existingAnalysisModels.map((m) => `#${m.expressId}`).join(', ');
  return <>
    <output className="block">{t('structuralDerive.counts', { ...counts, created: review.created })}</output>
    {plan.refusal !== null && <p role="alert">{t('structuralDerive.existing', { ids: existing })}</p>}
    {plan.refusal === null && review.created === 0 && <p role="alert">{t('structuralDerive.nothing')}</p>}
    {counts.assumedLoadBearing > 0 && <p>{t('structuralDerive.assumed', { count: counts.assumedLoadBearing })}</p>}
    <Listing summary={t('structuralDerive.skipped', { count: skipped.length })} rows={skipped} row={(item) => <>
      {item.type} #{item.elementId}{item.name ? ` ${item.name}` : ''}: {t(`structuralDerive.reason.${item.reason}`)} <span className="text-muted-foreground">({item.detail})</span>
    </>} />
    <Listing summary={t('structuralDerive.guessed', { count: plan.report.guessedSupports.length })} rows={plan.report.guessedSupports}
      row={nodeRow} />
    <Listing summary={t('structuralDerive.moved', { count: extendedEnds.length })} rows={extendedEnds}
      row={(move) => t('structuralDerive.movedRow', { element: move.elementId, end: t(`structuralDerive.end.${move.end}`),
        distance: move.distance.toFixed(3), to: move.toElementId })} />
    <Listing summary={t('structuralDerive.free', { count: freeEnds.length })} rows={freeEnds}
      row={nodeRow} />
    <Listing summary={t('structuralDerive.unconnected', { count: unconnectedEnds.length })} rows={unconnectedEnds}
      row={(end) => t('structuralDerive.endAt', { node: end.node + 1, position: metres(plan.nodes[end.node].position),
        landsOn: t(`structuralDerive.landsOn.${end.landsOn}`), element: end.landsOnElementId })} />
  </>;
}

/** The structural review step for a derived analysis model: derive, review, apply as one edit. */
export function StructuralDerivationReview({ origin }: { origin: string }) {
  const { t } = useTranslation();
  const modelId = useViewerStore(derivationModelId);
  const flow = useStructuralReview<Review>('Structural derivation', origin, true);
  const { review } = flow;
  // A prepared review stays on the model it derived, even if the active model changes.
  const target = review?.modelId ?? modelId;
  const modelName = useViewerStore((s) => (target === null ? null : s.models.get(target)?.name ?? target));
  // The receipt's rows: the analysis model, each member and each node.
  const derived = review ? 1 + review.plan.curveMembers.length + review.plan.surfaceMembers.length + review.plan.nodes.length : 0;
  return <section aria-label={t('commandPalette.tool.deriveStructural.label')} className="text-xs space-y-2">
    <p>{t('structuralDerive.hint')}</p>
    {modelName === null ? <p role="alert">{t('structuralDerive.noModel')}</p> : <p>{t('structuralDerive.model', { name: modelName })}</p>}
    <StructuralReviewControls flow={flow} acknowledgement={t('structuralDerive.acknowledgement')} prepareLabel={t('structuralDerive.prepare')}
      build={target === null ? undefined : () => prepareStructuralDerivationReview(useViewerStore, target)}
      applyCount={derived} canApply={(review?.created ?? 0) > 0}
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
      <DialogTitle>{t('commandPalette.tool.deriveStructural.label')}</DialogTitle>
      <StructuralDerivationReview key={session} origin={`palette:derive-structural:${session}`} />
    </DialogContent>
  </Dialog>;
}
