/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import { commitStructuralDerivation, derivationModelId, prepareStructuralDerivationReview, type StructuralDerivationReview as Review } from '@/lib/actions/structural-derive-review';
import { StructuralReviewControls, useStructuralReview } from './StructuralReviewFlow';

const metres = (p: readonly number[]) => p.map((v) => v.toFixed(2)).join(', ');

/** The plan a derivation would write: what it derives, what it skipped and why, and which supports it guessed. */
function DerivationSummary({ review }: { review: Review }) {
  const { t } = useTranslation();
  const { plan } = review;
  const { counts, skipped, unconnectedEnds } = plan.report;
  const guessed = plan.nodes.filter((node) => node.support?.guessed);
  return <>
    <output className="block">{t('structuralReview.derive.counts', { ...counts, created: review.created })}</output>
    {plan.derivedModelId !== null && <p role="alert">{t('structuralReview.derive.existing', { id: plan.derivedModelId })}</p>}
    {plan.derivedModelId === null && review.created === 0 && <p role="alert">{t('structuralReview.derive.nothing')}</p>}
    {counts.assumedLoadBearing > 0 && <p>{t('structuralReview.derive.assumed', { count: counts.assumedLoadBearing })}</p>}
    {skipped.length > 0 && <details><summary>{t('structuralReview.derive.skipped', { count: skipped.length })}</summary>
      <ul className="space-y-1 max-h-48 overflow-auto">{skipped.map((row) => <li key={row.elementId}>
        {row.type} #{row.elementId}{row.name ? ` ${row.name}` : ''}: <span className="text-muted-foreground">{row.reason} ({row.detail})</span>
      </li>)}</ul></details>}
    {guessed.length > 0 && <details><summary>{t('structuralReview.derive.guessed', { count: guessed.length })}</summary>
      <ul className="space-y-1 max-h-48 overflow-auto">{guessed.map((node) => <li key={node.index}>
        {t('structuralReview.derive.nodeAt', { node: node.index + 1, position: metres(node.position) })}
      </li>)}</ul></details>}
    {unconnectedEnds.length > 0 && <details><summary>{t('structuralReview.derive.unconnected', { count: unconnectedEnds.length })}</summary>
      <ul className="space-y-1 max-h-48 overflow-auto">{unconnectedEnds.map((end) => <li key={end.node}>
        {t('structuralReview.derive.endAt', { node: end.node + 1, position: metres(plan.nodes[end.node].position), landsOn: end.landsOn, element: end.landsOnElementId })}
      </li>)}</ul></details>}
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
      canPrepare={modelId !== null} onPrepare={() => { if (modelId !== null) flow.prepare(() => prepareStructuralDerivationReview(useViewerStore, modelId)); }}
      applyCount={members} canApply={review !== null && review.created > 0}
      onApply={() => flow.apply((current) => commitStructuralDerivation(useViewerStore, current, origin))}
      details={review && <DerivationSummary review={review} />} />
  </section>;
}
