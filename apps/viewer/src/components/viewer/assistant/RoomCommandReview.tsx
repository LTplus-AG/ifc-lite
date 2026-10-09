/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { RoomNativePreview } from './RoomNativePreview';
import { prepareRoomReview, type RoomReview } from '@/lib/actions/room-review';
import type { RoomProposal } from '@/lib/actions/room-command-proposal';
import type { RoomCommandResult } from '@ifc-lite/sdk';
import { commitReviewedRoom } from '@/lib/actions/room-receipt';
import { undoModelChanges, type ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import { modelChangeLibrary } from '@/lib/actions/receipts';

/** One explicit Room action, prepared asynchronously and committed only after review. */
export function RoomCommandReview({ proposal, origin, onAttach }: { proposal: RoomProposal; origin: string; onAttach?: (review: RoomReview) => void }) {
  const { t } = useTranslation();
  const [review, setReview] = useState<RoomReview | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [approved, setApproved] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [applied, setApplied] = useState<RoomCommandResult | null>(null);
  const [receipt, setReceipt] = useState<ModelChangeReceipt | null>(null);
  const [receiptProblem, setReceiptProblem] = useState(false);
  const owner = useRef({ sequence: 0, controller: null as AbortController | null, review: null as RoomReview | null, committing: false });
  useEffect(() => {
    const lease = owner.current;
    const detach = useViewerStore.subscribe(() => {
      if (!lease.review || lease.committing) return;
      try { lease.review.validate(); }
      catch { setStale(true); }
    });
    return () => { detach(); lease.sequence++; lease.controller?.abort(); lease.review?.dispose(); lease.review = null; };
  }, [proposal]);
  const prepare = async () => {
    const lease = owner.current, sequence = ++lease.sequence;
    lease.controller?.abort(); lease.review?.dispose(); lease.review = null;
    const controller = new AbortController();
    lease.controller = controller;
    setReview(null); setProblem(null); setStale(false); setPreparing(true);
    try {
      const next = await prepareRoomReview(proposal, controller.signal);
      if (lease.sequence !== sequence || controller.signal.aborted) { next.dispose(); return; }
      lease.review = next; setReview(next);
    } catch (error) {
      if (lease.sequence !== sequence || controller.signal.aborted) return;
      console.warn('[Assistant] Native Room preparation refused', error);
      setProblem(error instanceof Error ? error.message : String(error));
    } finally { if (lease.sequence === sequence) setPreparing(false); }
  };
  const apply = () => {
    if (!review || !approved || applied) return;
    const lease = owner.current;
    try {
      lease.committing = true;
      const { result, receipt: recorded } = commitReviewedRoom(review, origin);
      setApplied(result); setProblem(null);
      setReceipt(recorded);
      void modelChangeLibrary.put(recorded.id, recorded).then(ok => setReceiptProblem(!ok)).catch(error => {
        console.warn('[Assistant] Room receipt could not be stored', error); setReceiptProblem(true);
      });
      review.dispose(); lease.review = null;
    } catch (error) {
      console.warn('[Assistant] Native Room approval refused', error);
      setProblem(error instanceof Error ? error.message : String(error)); setStale(true);
    } finally { lease.committing = false; }
  };
  const c = proposal.command;
  const planned = review?.prepared.result;
  return <section aria-label={t('roomReview.title')} className="mx-3 my-2 rounded border border-border p-3 text-xs space-y-2">
    <h3 className="font-medium">{proposal.title}</h3>
    <p>{t(`roomReview.action.${c.action}`)} · {proposal.storey.Name || t('roomReview.unnamedStorey')}</p>
    <p className="text-muted-foreground">{t('roomReview.settings', { weld: c.weld, area: c.minArea, height: c.height, z: c.z, boundary: c.boundary })}</p>
    <p>{t('roomReview.prepareHint')}</p>
    {c.action === 'pick' && <p>{t('roomReview.point', { x: c.point[0], y: c.point[1] })}</p>}
    {(c.action === 'auto' || c.action === 'autoAll') && <p>{t(c.action === 'autoAll' ? 'roomReview.wholeAutoAll' : 'roomReview.wholeAuto')}</p>}
    {!applied && <Button size="sm" variant="outline" disabled={preparing} onClick={() => void prepare()}>
      {t(preparing ? 'roomReview.preparing' : 'roomReview.prepare')}
    </Button>}
    {preparing && <Button size="sm" variant="ghost" onClick={() => { owner.current.sequence++; owner.current.controller?.abort(); setPreparing(false); }}>{t('roomReview.cancel')}</Button>}
    {review && planned && <>
      <output className="block">{t(c.action==='autoAll'?'roomReview.populationAll':'roomReview.population', { candidates: review.snapshot.candidateCount, rooms: review.snapshot.roomCount })}</output>
      <p>{t('roomReview.planned', { created: planned.created.length, updated: planned.updated.length, deleted: planned.deleted.length, skipped: planned.skipped.length })}</p>
      {review.snapshot.storeys && <ul>
        {review.snapshot.storeys.map(row=><li key={row.expressId}>
          {row.Name || t('roomReview.unnamedStorey')} · #{row.expressId}: {t(`roomReview.coverage.${row.status}`)}
          {row.reason && <p>{row.reason}</p>}
          <p>{t('roomReview.population', {candidates:row.candidates.length,rooms:row.rooms.length})}</p>
        </li>)}
      </ul>}
      <RoomNativePreview review={review} />
      <ul className="max-h-48 overflow-auto list-disc pl-4">
        {planned.deleted.map(ref => <li key={`deleted:${ref.expressId}`}>{t('roomReview.deleteRoom', { name: review.snapshot.rooms.find(room => room.expressId === ref.expressId)?.Name || t('roomReview.unnamedRoom') })}</li>)}
      </ul>
      {planned.skipped.length > 0 && <p>{t('roomReview.skipped', { count: planned.skipped.length })}</p>}
      {(c.action === 'edit' || c.action === 'autoAll') && !planned.created.length && !planned.updated.length && !planned.deleted.length && <p>{t(c.action==='autoAll'?'roomReview.noChanges':'roomReview.sessionOnly')}</p>}
      {!applied && <label className="flex items-center gap-2"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />{t('roomReview.approveAction')}</label>}
      {!applied && <Button size="sm" disabled={!approved || stale || !!review.snapshot.storeys?.some(row=>row.status==='unavailable')} onClick={apply}>{t('roomReview.apply')}</Button>}
      {onAttach && !applied && !stale && <Button size="sm" variant="outline" onClick={() => {
        try { review.validate(); onAttach(review); }
        catch (error) { console.warn('[Assistant] Room attachment refused', error); setProblem(error instanceof Error ? error.message : String(error)); }
      }}>{t('roomReview.attach')}</Button>}
    </>}
    {stale && <p role="alert">{t('roomReview.stale')}</p>}
    {problem && <p role="alert" className="text-destructive break-words">{problem}</p>}
    {applied && <output className="block">{t('roomReview.applied', { created: applied.created.length, updated: applied.updated.length, deleted: applied.deleted.length })}</output>}
    {receipt && receipt.status === 'applied' && <Button size="sm" variant="outline" disabled={!receipt.batches.length} onClick={() => {
      const outcome = undoModelChanges(useViewerStore, receipt);
      if (!outcome.ok) { setProblem(outcome.reason); return; }
      const undone = { ...receipt, status: 'undone' as const, undoneAt: new Date().toISOString() };
      setReceipt(undone);
      void modelChangeLibrary.put(undone.id, undone).then(ok => setReceiptProblem(!ok)).catch(error => {
        console.warn('[Assistant] Undone Room receipt could not be stored', error); setReceiptProblem(true);
      });
    }}>{t('roomReview.undo')}</Button>}
    {receipt?.status === 'undone' && <output className="block">{t('roomReview.undone')}</output>}
    {receiptProblem && <p role="alert">{t('roomReview.receiptFailed')}</p>}
  </section>;
}
