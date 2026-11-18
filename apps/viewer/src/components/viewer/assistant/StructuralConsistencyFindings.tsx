/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model that already has an analysis model derives nothing beside it
 * (#9668). Below the line that says so (#10605): how the analysis model
 * compares with the physical model now, each finding's entities selectable,
 * and a way to show each analysis model.
 */
import { useEffect, useState } from 'react';
import type { StructuralConsistencyIssue } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import type { StructuralConsistencyReview } from '@/lib/actions/structural-consistency-review';
import { ElementLink, ElementLinks, linkedText, ShowAnalyticalModelButton } from './StructuralReviewLinks';
import { Listing } from './StructuralReviewListing';

function FindingRow({ modelId, issue }: { modelId: string; issue: StructuralConsistencyIssue }) {
  const { t } = useTranslation();
  const links = {
    item: <ElementLink modelId={modelId} expressId={issue.entityId} />,
    ...(issue.target === undefined ? {} : { element: <ElementLink modelId={modelId} expressId={issue.target} /> }),
  };
  return <>{linkedText(t, `structuralDerive.consistency.rule.${issue.rule}`, { distance: issue.distance?.toFixed(3) ?? '' }, links)}</>;
}

/** An analysis model as a link, with the button that shows it. */
function AnalysisModelRow({ modelId, expressId, memberIds }: { modelId: string; expressId: number; memberIds: readonly number[] }) {
  return <div className="flex items-center gap-2">
    <ElementLink modelId={modelId} expressId={expressId} />
    <ShowAnalyticalModelButton modelId={modelId} analysisModelId={expressId} memberIds={memberIds} />
  </div>;
}

/**
 * Runs the consistency checks for `modelId` and lists what they find. They run
 * again for each new `prepared` review, since the model may have changed in between.
 * If the check itself fails, the `existing` analysis models the plan read can still be shown.
 */
export function StructuralConsistencyFindings({ modelId, prepared, existing }: {
  modelId: string; prepared: object; existing: readonly { expressId: number; memberIds: readonly number[] }[];
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<StructuralConsistencyReview | 'checking' | { failed: string }>('checking');
  useEffect(() => {
    let live = true;
    setResult('checking');
    // Lazy: the checks export and re-parse an edited model, and read every curve element's shape.
    import('@/lib/actions/structural-consistency-review')
      .then(({ reviewStructuralConsistency }) => reviewStructuralConsistency(useViewerStore.getState(), modelId))
      .then((review) => { if (live) setResult(review); }, (error: unknown) => {
        console.warn('[Structural derivation] consistency check failed', error);
        if (live) setResult({ failed: error instanceof Error ? error.message : String(error) });
      });
    return () => { live = false; };
  }, [modelId, prepared]);
  if (result === 'checking') return <output className="block">{t('structuralDerive.consistency.checking')}</output>;
  if ('failed' in result) return <section aria-label={t('structuralDerive.consistency.title')} className="space-y-2">
    <p role="alert">{t('structuralDerive.consistency.failed', { error: result.failed })}</p>
    {existing.map((model) => <AnalysisModelRow key={model.expressId} modelId={modelId} expressId={model.expressId} memberIds={model.memberIds} />)}
  </section>;
  const { linked, skipped } = result.axisCoverage;
  return <section aria-label={t('structuralDerive.consistency.title')} className="space-y-2">
    {result.analysisModels.map((model) => <AnalysisModelRow key={model.expressId} modelId={modelId} expressId={model.expressId} memberIds={model.memberIds} />)}
    {result.issues.length === 0
      ? <output className="block">{skipped.length === 0 ? t('structuralDerive.consistency.consistent')
        : t('structuralDerive.consistency.partial', { count: skipped.length, total: linked })}</output>
      : <Listing open summary={t('structuralDerive.consistency.findings', { count: result.issues.length })} rows={result.issues}
        row={(issue) => <FindingRow modelId={modelId} issue={issue} />} />}
    <Listing open summary={t('structuralDerive.consistency.unchecked', { count: skipped.length })} rows={skipped}
      row={({ memberId, elementIds }) => linkedText(t, 'structuralDerive.consistency.uncheckedRow', {}, {
        item: <ElementLink modelId={modelId} expressId={memberId} />,
        elements: <ElementLinks modelId={modelId} ids={elementIds} />,
      })} />
  </section>;
}
