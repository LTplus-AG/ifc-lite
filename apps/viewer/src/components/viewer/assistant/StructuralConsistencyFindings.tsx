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
import { ElementLink, linkedText, ShowAnalyticalModelButton } from './StructuralReviewLinks';
import { Listing } from './StructuralReviewListing';

function FindingRow({ modelId, issue }: { modelId: string; issue: StructuralConsistencyIssue }) {
  const { t } = useTranslation();
  const links = {
    item: <ElementLink modelId={modelId} expressId={issue.entityId} />,
    ...(issue.target === undefined ? {} : { element: <ElementLink modelId={modelId} expressId={issue.target} /> }),
  };
  return <>{linkedText(t, `structuralDerive.consistency.rule.${issue.rule}`, { distance: issue.distance?.toFixed(3) ?? '' }, links)}</>;
}

/**
 * Runs the consistency checks for `modelId` and lists what they find. They run
 * again for each new `prepared` review, since the model may have changed in between.
 */
export function StructuralConsistencyFindings({ modelId, prepared }: { modelId: string; prepared: object }) {
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
  if ('failed' in result) return <p role="alert">{t('structuralDerive.consistency.failed', { error: result.failed })}</p>;
  return <section aria-label={t('structuralDerive.consistency.title')} className="space-y-2">
    {result.analysisModels.map((model) => <div key={model.expressId} className="flex items-center gap-2">
      <ElementLink modelId={modelId} expressId={model.expressId} />
      <ShowAnalyticalModelButton modelId={modelId} analysisModelId={model.expressId} memberIds={model.memberIds} />
    </div>)}
    {result.issues.length === 0
      ? <output className="block">{t(result.checkedAxes ? 'structuralDerive.consistency.consistent' : 'structuralDerive.consistency.consistentWithoutAxes')}</output>
      : <Listing open summary={t('structuralDerive.consistency.findings', { count: result.issues.length })} rows={result.issues}
        row={(issue) => <FindingRow modelId={modelId} issue={issue} />} />}
  </section>;
}
