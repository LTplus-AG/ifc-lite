/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import type { ReportReceipt } from '@ifc-lite/report-contract';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { ReportClient, safePublicModelUrl } from '@/services/error-reports/client';

export function PublicModelReceipt({ receipt, client, onChange, disabled = false }: {
  receipt: ReportReceipt; client: ReportClient; onChange: (receipt: ReportReceipt) => void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ controller: AbortController; receipt: ReportReceipt; withdraw: boolean } | undefined>(undefined);
  const latestReceipt = useRef(receipt);
  const withdrawnReport = useRef<string | undefined>(undefined);
  const deletedReport = useRef<string | undefined>(undefined);
  if (latestReceipt.current.id !== receipt.id) { withdrawnReport.current = undefined; deletedReport.current = undefined; }
  latestReceipt.current = receipt;
  if (receipt.publicModel?.state === 'withdrawn') withdrawnReport.current = receipt.id;
  if (receipt.status === 'deleted') deletedReport.current = receipt.id;
  useEffect(() => () => pending.current?.controller.abort(), []);
  useEffect(() => {
    const request = pending.current;
    // A same-report refresh may supersede a GET, but cannot cancel an
    // authoritative withdrawal. Changing report or deletion invalidates both.
    if (request && (!request.withdraw || request.receipt.id !== receipt.id || deletedReport.current === receipt.id)) {
      request.controller.abort(); pending.current = undefined;
    }
    if (!pending.current) { setBusy(false); setConfirm(false); }
    setError('');
  }, [receipt]);
  const model: ReportReceipt['publicModel'] = withdrawnReport.current === receipt.id ? { state: 'withdrawn' } : receipt.publicModel;
  if (!model || deletedReport.current === receipt.id) return null;
  const url = safePublicModelUrl(model.downloadUrl);
  const statusKey = model.state === 'available' && url ? 'errorReport.publicAvailable' :
    model.state === 'withdrawn' ? 'errorReport.publicWithdrawn' :
    model.state === 'held' || model.state === 'available' ? 'errorReport.publicHeld' :
    model.state === 'review' ? 'errorReport.publicReviewPending' : 'errorReport.publicScanPending';
  async function request(withdraw: boolean) {
    if (pending.current || disabled) return;
    const controller = new AbortController();
    const work = { controller, receipt, withdraw }; pending.current = work;
    const relevant = () => !controller.signal.aborted && latestReceipt.current.id === receipt.id &&
      deletedReport.current !== receipt.id && (withdraw || latestReceipt.current === receipt);
    setBusy(true); setError('');
    try {
      const next = await client.request<ReportReceipt>(`/${encodeURIComponent(receipt.id)}${withdraw ? '/public-model' : ''}`,
        withdraw ? 'DELETE' : 'GET', undefined, controller.signal);
      if (next.id !== receipt.id || (withdraw && next.publicModel?.state !== 'withdrawn')) throw new Error('Public model status was not confirmed. Please retry.');
      if (relevant()) {
        if (withdraw) withdrawnReport.current = receipt.id;
        onChange(next); setConfirm(false);
      }
    } catch (reason) {
      if (relevant()) setError(reason instanceof Error ? reason.message : 'Public model request failed');
    } finally {
      if (pending.current === work) { if (!controller.signal.aborted) setBusy(false); pending.current = undefined; }
    }
  }
  return <section className="space-y-2 rounded border p-3" aria-label={t('errorReport.publicModelStatus')}>
    <output className="block">{t(statusKey)}</output>
    {model.state === 'available' && url && <a className="block" href={url} target="_blank" rel="noreferrer">{t('errorReport.downloadPublicModel')}</a>}
    {model.state === 'available' && model.expiresAt && Number.isFinite(Date.parse(model.expiresAt)) && <p>{t('errorReport.publicExpiry', { date: new Date(model.expiresAt).toLocaleString() })}</p>}
    {error && <p role="alert">{error}</p>}
    {model.state !== 'withdrawn' && (confirm ? <>
      <p>{t('errorReport.withdrawPublicConfirm')}</p>
      <Button disabled={busy || disabled} variant="destructive" onClick={() => { void request(true); }}>{t('errorReport.confirmWithdrawPublic')}</Button>
      <Button disabled={busy || disabled} variant="outline" onClick={() => setConfirm(false)}>{t('errorReport.keepPublic')}</Button>
    </> : <>
      <Button disabled={busy || disabled} variant="outline" onClick={() => { void request(false); }}>{t('errorReport.checkPublicStatus')}</Button>
      <Button disabled={busy || disabled} variant="outline" onClick={() => setConfirm(true)}>{t('errorReport.withdrawPublic')}</Button>
    </>)}
  </section>;
}
