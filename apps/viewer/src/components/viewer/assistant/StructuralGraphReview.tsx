/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import type { StructuralProposal } from '@/lib/actions/structural-graph-proposal';
import { prepareStructuralReview, type StructuralReview } from '@/lib/actions/structural-graph-review';
import { commitReviewedStructural } from '@/lib/actions/structural-graph-receipt';
import { StructuralReviewControls, useStructuralReview } from './StructuralReviewFlow';

/** Explicit review and selective approval; analytical data never enters a geometry workplane or ghost. */
export function StructuralGraphReview({ proposal, origin }: { proposal: StructuralProposal; origin: string }) {
  const { t } = useTranslation();
  const [approved, setApproved] = useState(() => new Set(proposal.operations.map((_, index) => index)));
  const flow = useStructuralReview<StructuralReview>('Assistant Structural', proposal);
  const { review, receipt } = flow;
  const prepare = (selection: ReadonlySet<number>) => flow.prepare(() => prepareStructuralReview(useViewerStore, proposal, selection));
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
    <StructuralReviewControls flow={flow} acknowledgement={t('structuralReview.acknowledgement')} prepareLabel={t('structuralReview.prepare')}
      build={approved.size > 0 ? () => prepareStructuralReview(useViewerStore, proposal, approved) : undefined}
      applyCount={approved.size} canApply={approved.size > 0}
      commit={current => commitReviewedStructural(useViewerStore, current, origin)}
      details={review && <>
        <output className="block">{t('structuralReview.population', { records: review.snapshot.records.length,
          created: delta.filter(row => !row.before).length, modified: delta.filter(row => row.before && row.after).length, deleted: delta.filter(row => !row.after).length })}</output>
        <details><summary>{t('structuralReview.units')}</summary><pre className="whitespace-pre-wrap break-words">{JSON.stringify({ declaredUnits: review.snapshot.declaredUnits, diagnostics: review.snapshot.unitDiagnostics }, null, 2)}</pre></details>
        <details><summary>{t('structuralReview.nativeChanges')}</summary><ul className="space-y-2 max-h-64 overflow-auto">
          {delta.map(row => <li key={row.expressId}><p>{row.after?.type ?? row.before?.type} #{row.expressId}</p>
            <pre className="whitespace-pre-wrap break-words">{JSON.stringify(row.before?.attributes ?? null)}{' → '}{JSON.stringify(row.after?.attributes ?? null)}</pre></li>)}
        </ul></details>
      </>} />
  </section>;
}
