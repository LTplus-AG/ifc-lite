/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Fragment } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { registerEnglish } from '@/i18n';
import { structuralDeriveEn } from '@/i18n/catalogues/structural-derive.en';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import { commitStructuralDerivation, derivationModelId, prepareStructuralDerivationReview, type StructuralDerivationReview as Review } from '@/lib/actions/structural-derive-review';
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import { StructuralReviewControls, useStructuralReview } from './StructuralReviewFlow';
import { StructuralConsistencyFindings } from './StructuralConsistencyFindings';
import { ElementLink, linkedText, ShowAnalyticalModelButton } from './StructuralReviewLinks';
import { Listing } from './StructuralReviewListing';

// The review's copy loads with this chunk (#6923), not at first load.
registerEnglish(structuralDeriveEn);

const metres = (p: readonly number[]) => p.map((v) => v.toFixed(2)).join(', ');

/** The plan a derivation would write: what it derives, what it skipped and why, and which supports it guessed. */
export function DerivationSummary({ review }: { review: Review }) {
  const { t } = useTranslation();
  const { plan, modelId } = review;
  const link = (expressId: number) => <ElementLink modelId={modelId} expressId={expressId} />;
  const nodeRow = (index: number) => <>{t('structuralDerive.nodeAt', { node: index + 1, position: metres(plan.nodes[index].position) })}
    {plan.nodes[index].elementIds.map((id) => <Fragment key={id}> {link(id)}</Fragment>)}</>;
  const { counts, skipped, skippedOpenings, unconnectedEnds, extendedEnds, freeEnds } = plan.report;
  const existing = plan.existingAnalysisModels.map((m) => `#${m.expressId}`).join(', ');
  return <>
    <output className="block">{t('structuralDerive.counts', { ...counts, created: review.created })}</output>
    {plan.refusal !== null && <p role="alert">{t('structuralDerive.existing', { ids: existing })}</p>}
    {plan.refusal === null && review.created === 0 && <p role="alert">{t('structuralDerive.nothing')}</p>}
    {plan.existingAnalysisModels.length > 0 && review.created === 0 && <StructuralConsistencyFindings modelId={modelId} prepared={review} />}
    {counts.assumedLoadBearing > 0 && <p>{t('structuralDerive.assumed', { count: counts.assumedLoadBearing })}</p>}
    <Listing summary={t('structuralDerive.skipped', { count: skipped.length })} rows={skipped} row={(item) => <>
      {link(item.elementId)}: {t(`structuralDerive.reason.${item.reason}`)} <span className="text-muted-foreground">({item.detail})</span>
    </>} />
    <Listing summary={t('structuralDerive.skippedOpenings', { count: skippedOpenings.length })} rows={skippedOpenings}
      row={(item) => <>{linkedText(t, 'structuralDerive.skippedOpeningRow', { reason: t(`structuralDerive.reason.${item.reason}`) },
        { opening: link(item.openingId), host: link(item.hostId) })} <span className="text-muted-foreground">({item.detail})</span></>} />
    <Listing summary={t('structuralDerive.guessed', { count: plan.report.guessedSupports.length })} rows={plan.report.guessedSupports}
      row={nodeRow} />
    <Listing summary={t('structuralDerive.moved', { count: extendedEnds.length })} rows={extendedEnds}
      row={(move) => linkedText(t, 'structuralDerive.movedRow', { end: t(`structuralDerive.end.${move.end}`), distance: move.distance.toFixed(3) },
        { element: link(move.elementId), to: link(move.toElementId) })} />
    <Listing summary={t('structuralDerive.free', { count: freeEnds.length })} rows={freeEnds}
      row={nodeRow} />
    <Listing summary={t('structuralDerive.unconnected', { count: unconnectedEnds.length })} rows={unconnectedEnds}
      row={(end) => linkedText(t, 'structuralDerive.endAt', { node: end.node + 1, position: metres(plan.nodes[end.node].position),
        landsOn: t(`structuralDerive.landsOn.${end.landsOn}`) }, { element: link(end.landsOnElementId) })} />
  </>;
}

/** After Apply: show the analysis model the receipt created, its members framed. */
function ShowDerived({ receipt }: { receipt: ModelChangeReceipt }) {
  const created = receipt.applied.find((row) => row.op === 'structural.analysis.create');
  // Every structural receipt row carries its written record's id; a row without one has nothing to select.
  if (created?.expressId === undefined) return null;
  const members = receipt.applied.flatMap((row) => row.op === 'structural.member.create' && row.expressId !== undefined ? [row.expressId] : []);
  return <ShowAnalyticalModelButton modelId={created.modelId} analysisModelId={created.expressId} memberIds={members} />;
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
  return <section aria-label={t('commandPalette.tool.deriveStructural.label')} className="text-xs space-y-2">
    <p>{t('structuralDerive.hint')}</p>
    {modelName === null ? <p role="alert">{t('structuralDerive.noModel')}</p> : <p>{t('structuralDerive.model', { name: modelName })}</p>}
    <StructuralReviewControls flow={flow} acknowledgement={t('structuralDerive.acknowledgement')} prepareLabel={t('structuralDerive.prepare')}
      build={modelId === null ? undefined : () => prepareStructuralDerivationReview(useViewerStore, modelId)}
      applyCount={review?.derived ?? 0} canApply={(review?.created ?? 0) > 0}
      commit={(current) => commitStructuralDerivation(useViewerStore, current, origin)}
      details={review && <DerivationSummary review={review} />} />
    {flow.receipt && <ShowDerived receipt={flow.receipt} />}
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
