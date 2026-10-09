/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n/useTranslation';
import type { ZoneEmissionProposal } from '@/lib/actions/zone-emission-proposal';
import { prepareZoneEmission, type ZoneEmissionReview as NativeReview } from '@/lib/actions/zone-emission-review';
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { ReceiptSummary } from '../actions/ModelChangeReview';
export function ZoneEmissionReview({ proposal, origin }: { proposal: ZoneEmissionProposal; origin: string }) {
  const { t } = useTranslation(), [review, setReview] = useState<NativeReview | null>(null), [problem, setProblem] = useState<string | null>(null), [stale, setStale] = useState(false), [receipt, setReceipt] = useState<ModelChangeReceipt | null>(null), [receiptProblem, setReceiptProblem] = useState(false);
  const owner = useRef({ mounted: true, review: null as NativeReview | null, applying: false });
  useEffect(() => {
    const current = owner.current; current.mounted = true;
    const unsubscribe = useViewerStore.subscribe(() => { if (!current.review || current.applying) return; try { current.review.validate(); } catch (error) { console.warn('[Assistant] Native evaluated zone review became stale', error); setStale(true); } });
    return () => { current.mounted = false; current.review = null; unsubscribe(); };
  }, [proposal]);
  const prepare = () => { try { const next = prepareZoneEmission(useViewerStore, proposal); owner.current.review = next; setReview(next); setStale(false); setProblem(null); } catch (error) { console.warn('[Assistant] Native zone emission refused', error); owner.current.review = null; setReview(null); setProblem(error instanceof Error ? error.message : String(error)); } };
  const apply = () => {
    if (!owner.current.mounted || !review || owner.current.review !== review || stale || receipt) return;
    try {
      owner.current.applying = true; const result = review.commit(origin); owner.current.review = null; setReceipt(result); setProblem(null);
      void modelChangeLibrary.put(result.id, result).then(saved => { if (owner.current.mounted) setReceiptProblem(!saved); }).catch(error => { console.warn('[Assistant] Zone emission receipt unavailable', error); if (owner.current.mounted) setReceiptProblem(true); });
    } catch (error) { console.warn('[Assistant] Reviewed zone emission refused', error); setProblem(error instanceof Error ? error.message : String(error)); setStale(true); }
    finally { owner.current.applying = false; }
  };
  return <section aria-label={t('zoneEmission.title')} className="mx-3 my-2 border border-border rounded p-3 text-xs space-y-2">
    <h3 className="font-medium">{proposal.title}</h3><p>{t('zoneEmission.hint')}</p><p>{t('zoneEmission.limit')}</p>
    {!receipt && <Button size="sm" variant="outline" onClick={prepare}>{t('zoneEmission.prepare')}</Button>}
    {review && <><output className="block">{t('zoneEmission.population', { zones: review.dry.outcome.zonesEmitted, members: review.snapshot.members.length, replaced: review.dry.outcome.zonesReplaced, imported: review.snapshot.importedSourceZonesRetained })}</output>
      <details><summary>{t('zoneEmission.records')}</summary><pre className="whitespace-pre-wrap">{JSON.stringify(review.dry.created, null, 2)}</pre></details>
      <details><summary>{t('zoneEmission.frame')}</summary><pre className="whitespace-pre-wrap">{JSON.stringify({ modelId: proposal.modelId, zoneSet: review.snapshot.set.name, storey: proposal.storey.Name, lengthUnitScale: review.snapshot.lengthUnitScale, frame: review.snapshot.frame })}</pre></details>
      {!receipt && <Button size="sm" disabled={stale} onClick={apply}>{t('zoneEmission.apply')}</Button>}</>}
    {problem && <p role="alert">{problem}</p>}{stale && !receipt && <p role="alert">{t('modelChanges.refused.stale')}</p>}
    {receipt && <ReceiptSummary receipt={receipt} />}{receiptProblem && <p role="alert">{t('zoneEmission.receiptProblem')}</p>}
  </section>;
}
