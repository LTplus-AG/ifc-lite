/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { completeReport, forgetReport, rememberReport } from '@/lib/error-reports/pending';
import { useEffect, useRef, useState } from 'react';
import type { ReportDiagnostics, ReportReceipt, ReportSession } from '@ifc-lite/report-contract';
import { useTranslation } from '@/i18n';
import type { ReportContext } from '@/lib/error-reports/context';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ReportClient, ReportRequestError, safeAgreementUrl, safeIssueUrl } from '@/services/error-reports/client';
import { ReportSubmission, type ReviewedReport } from '@/services/error-reports/submission';
import { ReportIssueDestination, type IssueChoice } from './ReportIssueDestination';
import { emptyAttachment, ReportAttachment, validAttachment, type AttachmentChoice } from './ReportAttachment';

export function ErrorReportDialog({ context, onClose, client: injectedClient }: { context: ReportContext; onClose: () => void; client?: ReportClient }) {
  const { t } = useTranslation();
  const [client] = useState(() => injectedClient ?? new ReportClient());
  const [session, setSession] = useState<ReportSession>();
  const [unavailable, setUnavailable] = useState(false);
  const [restoring, setRestoring] = useState(!!context.resumeReportId);
  const [title, setTitle] = useState(() => {
    if (/^(?:gpu_|renderer_|persistent_render_)/.test(context.errorCode)) return t('errorReport.defaultRenderingTitle');
    if (context.sourceFile || /(?:^|_)(?:load|parse|geometry|wasm|file|network)(?:_|$)/.test(context.errorCode)) return t('errorReport.defaultLoadingTitle');
    return t('errorReport.defaultGeneralTitle');
  });
  const [description, setDescription] = useState('');
  const [issueChoice, setIssueChoice] = useState<IssueChoice>({ reviewed: !context.correlation });
  const [attachment, setAttachment] = useState<AttachmentChoice>(emptyAttachment);
  const [review, setReview] = useState<ReviewedReport>();
  const [existing, setExisting] = useState<ReportReceipt>();
  const [receipt, setReceipt] = useState<ReportReceipt>();
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const deleting = useRef(false);
  const [publicationPending, setPublicationPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uploaded, setUploaded] = useState(0);
  const submission = useRef<ReportSubmission | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<ReportDiagnostics>(() => ({
    errorCode: /^[a-zA-Z0-9_-]{1,160}$/.test(context.errorCode) ? context.errorCode : 'viewer_error',
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
    buildSha: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev',
  }));
  useEffect(() => {
    const controller = new AbortController();
    void client.session(controller.signal).then(async value => {
      setSession(value);
      if (context.resumeReportId) {
        const restored = await client.request<ReportReceipt>(`/${encodeURIComponent(context.resumeReportId)}`, 'GET', undefined, controller.signal);
        restoreReceipt(restored);
      }
    }).catch(reason => {
      if (!controller.signal.aborted) {
        if (context.resumeReportId && reason instanceof ReportRequestError && reason.status === 404 && reason.code === 'report_missing') forgetReport(context.resumeReportId);
        console.warn('[error-report] Session unavailable', reason);
        setUnavailable(true); setSession(undefined); setRestoring(false);
      }
    });
    return () => { controller.abort(); abort.current?.abort(); };
  }, [client]);

  useEffect(() => {
    if (receipt?.status !== 'submitted' || receipt.publicationHold || deleteState !== 'idle') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    setPublicationPending(false);
    const poll = async () => {
      try {
        const next = await client.request<ReportReceipt>(`/${encodeURIComponent(receipt.id)}`, 'GET', undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (next.publicationHold) { setReceipt(next); return; }
        if (next.status === 'published') { completeReport(next.id); setReceipt(next); return; }
        if (++attempts >= 20) { setPublicationPending(true); return; }
        timer = setTimeout(() => { void poll(); }, 3000);
      } catch (reason) {
        if (!controller.signal.aborted) { console.warn('[error-report] Publication status unavailable', reason); setPublicationPending(true); }
      }
    };
    timer = setTimeout(() => { void poll(); }, 3000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [client, receipt?.id, receipt?.status, receipt?.publicationHold, deleteState]);

  function restoreReceipt(restored: ReportReceipt) {
    setRestoring(false);
    if (restored.status === 'deleted') { forgetReport(restored.id); setReceipt(restored); return; }
    if (['submitted', 'published', 'manual_review'].includes(restored.status)) {
      if (restored.status === 'published') completeReport(restored.id);
      else rememberReport(restored.id, true);
      setReceipt(restored); return;
    }
    if (!restored.draft || restored.status !== 'draft') throw new Error('Report cannot be resumed');
    setExisting(restored); setReceipt(undefined); setReview(undefined); submission.current = undefined;
    setTitle(restored.draft.title); setDescription(restored.draft.description); setDiagnostics(restored.draft.diagnostics);
    setAttachment({ ...emptyAttachment, visibility: restored.draft.visibility,
      confidentiality: restored.customNdaStatus === 'approved' ? 'custom' : restored.uploadSource?.confidentiality ?? 'none',
      uploadConsent: !!restored.uploadSource });
  }
  async function deletePrivateReport() {
    if (!receipt || deleting.current) return;
    deleting.current = true; setDeleteState('deleting'); setError('');
    try {
      const deleted = await client.request<ReportReceipt>(`/${encodeURIComponent(receipt.id)}`, 'DELETE');
      if (deleted.status !== 'deleted' || deleted.id !== receipt.id) throw new Error('Deletion was not confirmed. Please retry.');
      forgetReport(receipt.id);
      setReceipt({ ...deleted, issueUrl: deleted.issueUrl ?? receipt.issueUrl });
      setDeleteState('idle');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Deletion failed');
      setDeleteState('confirm');
    } finally { deleting.current = false; }
  }
  async function refreshReceipt() {
    if (!receipt) return;
    try { restoreReceipt(await client.request<ReportReceipt>(`/${encodeURIComponent(receipt.id)}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Request failed'); }
  }
  const customApproved = existing?.customNdaStatus === 'approved' && !existing.uploadSource;
  const resumeFileValid = !existing?.uploadSource || existing.upload?.status === 'ready' || (!!attachment.file && attachment.file.name === existing.uploadSource.name && attachment.file.size === existing.uploadSource.size);
  const canReview = !!session && !!title.trim() && (!!existing || issueChoice.reviewed) && (existing ? resumeFileValid && (!customApproved || (!!attachment.file && attachment.uploadConsent && validAttachment({ ...attachment, confidentiality: 'none' }, session))) : validAttachment(attachment, session));
  function prepareReview() {
    if (!session || !canReview) return;
    setReview({
      draft: existing?.draft ?? { clientRequestId: crypto.randomUUID(), title: title.trim(), description, diagnostics, visibility: attachment.visibility, ...(issueChoice.target ? { issueTarget: issueChoice.target } : {}) },
      file: attachment.file, confidentiality: attachment.confidentiality, publicModelConfirmed: attachment.publicConfirmed,
      customNdaMessage: attachment.customMessage,
      ...(attachment.confidentiality === 'standard' ? { acceptance: {
        agreementSha256: session.agreement.sha256, signerName: attachment.signerName,
        signerEmail: attachment.signerEmail, organization: attachment.organization,
        authorityConfirmed: true, accepted: true,
      } } : {}),
    });
  }
  function send() {
    if (!review || inFlight.current) return;
    const controller = new AbortController();
    abort.current = controller;
    submission.current ??= new ReportSubmission(review, client, existing);
    setBusy(true); setError('');
    inFlight.current = submission.current.send(controller.signal, setUploaded).then(setReceipt).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Request failed');
    }).finally(() => { setBusy(false); inFlight.current = undefined; });
  }
  async function closeDialog() {
    if (deleting.current || inFlight.current) return;
    // Closing preserves an existing report; deletion requires its labelled action.
    abort.current?.abort();
    await inFlight.current;
    onClose();
  }
  async function cancel() {
    if (deleting.current) return;
    if (receipt) { onClose(); return; }
    abort.current?.abort();
    await inFlight.current;
    try {
      if (submission.current) await submission.current.cancel();
      else if (context.resumeReportId) { await client.request(`/${encodeURIComponent(context.resumeReportId)}`, 'DELETE'); forgetReport(context.resumeReportId); }
      onClose();
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Cancellation failed'); }
  }
  const issueUrl = safeIssueUrl(receipt?.issueUrl);
  const agreementUrl = safeAgreementUrl(submission.current?.agreementReceipt?.pdfUrl ?? (receipt?.agreementAccepted ? `/api/reports/${receipt.id}/agreement.pdf` : undefined));
  return <Dialog open onOpenChange={open => { if (!open) void closeDialog(); }}>
    <DialogContent className="ph-no-capture ph-mask max-h-[90vh] overflow-y-auto" hideCloseButton={busy || deleteState === 'deleting'} onEscapeKeyDown={event => { if (inFlight.current || deleting.current) event.preventDefault(); }} onPointerDownOutside={event => { if (inFlight.current || deleting.current) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{t(receipt?.status === 'deleted' ? 'errorReport.deletedTitle' : receipt?.status === 'manual_review' ? 'errorReport.ndaRequestReceived' : receipt ? 'errorReport.sent' : review ? 'errorReport.reviewTitle' : 'errorReport.invite')}</DialogTitle>
        <DialogDescription>{t(receipt?.status === 'deleted' ? 'errorReport.deletedDescription' : receipt?.status === 'manual_review' ? 'errorReport.manual' : receipt ? 'errorReport.receivedDescription' : 'errorReport.intro')}</DialogDescription></DialogHeader>
      {receipt ? <div className="space-y-3">
        <p>{t('errorReport.receipt', { id: receipt.id })}</p>
        {receipt.status === 'submitted' && deleteState === 'idle' && <><output>{t(receipt.publicationHold ? 'errorReport.publicationHeld' : publicationPending ? 'errorReport.publicationPending' : 'errorReport.publishing')}</output><Button variant="outline" onClick={() => { void refreshReceipt(); }}>{t('errorReport.checkStatus')}</Button></>}
        {receipt.status === 'manual_review' && deleteState === 'idle' && <><Button variant="outline" onClick={() => { void refreshReceipt(); }}>{t('errorReport.checkStatus')}</Button></>}
        {error && <p role="alert">{error}</p>}
        {issueUrl && <a href={issueUrl} target="_blank" rel="noreferrer">{t('errorReport.issue')}</a>}
        {receipt.status !== 'deleted' && agreementUrl && <a className="block" href={agreementUrl} target="_blank" rel="noreferrer">{t('errorReport.agreementReceipt')}</a>}
        {receipt.status !== 'deleted' && (deleteState === 'idle' ? <Button variant="outline" onClick={() => { setError(''); setDeleteState('confirm'); }}>{t('errorReport.deletePrivate')}</Button> : <div className="space-y-2 rounded border border-destructive/40 p-3">
          <p>{t('errorReport.deleteConfirm')}</p>
          <p>{t('errorReport.deletePublicUnchanged')}</p>
          <p>{t('errorReport.deleteRetention')}</p>
          {session && <p>{t('errorReport.deletion', { days: session.storage.deletionDays })} {session.storage.backupDisclosure}</p>}
          <Button variant="destructive" disabled={deleteState === 'deleting'} onClick={() => { void deletePrivateReport(); }}>{t(deleteState === 'deleting' ? 'errorReport.deleting' : 'errorReport.confirmDelete')}</Button>
          <Button variant="outline" disabled={deleteState === 'deleting'} onClick={() => setDeleteState('idle')}>{t('errorReport.keepReport')}</Button>
        </div>)}
        <Button disabled={deleteState === 'deleting'} onClick={onClose}>{t('errorReport.close')}</Button>
      </div> : !session || restoring ? <div><output>{t(unavailable ? 'errorReport.unavailable' : 'errorReport.loading')}</output>{unavailable && <Button onClick={() => { void closeDialog(); }}>{t('errorReport.close')}</Button>}</div> : <>
        {!review ? <div className="space-y-3 text-sm">
          <p>{t('errorReport.publicText')}</p>
          <label className="block">{t('errorReport.title')}<input className="block w-full rounded border bg-background p-2" disabled={!!existing} value={title} maxLength={180} onChange={event => setTitle(event.target.value)} /></label>
          <label className="block">{t('errorReport.description')}<textarea className="block min-h-24 w-full rounded border bg-background p-2" disabled={!!existing} value={description} maxLength={10000} onChange={event => setDescription(event.target.value)} /></label>
          {!existing && <ReportIssueDestination correlation={context.correlation} enabled={!!session.issueLinkingEnabled} client={client} value={issueChoice} onChange={setIssueChoice} />}
          {existing ? <div>
            <p>{t('errorReport.resume')}</p>
            {existing.uploadSource && <p>{t('errorReport.source', { name: existing.uploadSource.name, size: existing.uploadSource.size })}</p>}
            {(customApproved || (existing.uploadSource && existing.upload?.status !== 'ready')) && <label>{t('errorReport.chooseFile')}<input type="file" accept=".ifc,.ifczip,.ifcx" onChange={event => setAttachment({ ...attachment, file: event.target.files?.[0] })} /></label>}
            {customApproved && <label className="block"><input type="checkbox" checked={attachment.uploadConsent} onChange={event => setAttachment({ ...attachment, uploadConsent: event.target.checked })} /> {t('errorReport.uploadConsent')}</label>}
            {!resumeFileValid && <p>{t('errorReport.resumeMismatch')}</p>}
          </div> : <ReportAttachment context={context} session={session} value={attachment} onChange={setAttachment} />}
          <Button disabled={!canReview} onClick={prepareReview}>{t('errorReport.review')}</Button>
        </div> : <div className="space-y-3 text-sm">
          <p>{review.draft.issueTarget || existing?.issueDestination ? t('errorReport.addToIssue') + ' ' + (review.draft.issueTarget?.issueUrl ?? existing?.issueDestination?.issueUrl) : t('errorReport.newIssue')}</p>
          <p>{t('errorReport.publicText')}</p>
          <p className="break-words font-medium">{review.draft.title}</p><p className="whitespace-pre-wrap break-words">{review.draft.description}</p>
          <p>{t('errorReport.diagnostics')}</p><pre className="overflow-auto text-xs">{JSON.stringify(diagnostics, null, 2)}</pre>
          <p>{review.file || existing?.uploadSource ? t('errorReport.source', { name: review.file?.name ?? existing!.uploadSource!.name, size: review.file?.size ?? existing!.uploadSource!.size }) : t('errorReport.noModel')}</p>
          {review.file && <p>{t(review.draft.visibility === 'private' ? 'errorReport.privateHelp' : 'errorReport.publicHelp')}</p>}
          {review.file && <div><p>{t('errorReport.privateReview')}</p>
            {review.acceptance && <p>{review.acceptance.signerName} · {review.acceptance.signerEmail} · {review.acceptance.organization}<br />{session.agreement.version}</p>}
            {review.confidentiality === 'custom' && <p className="whitespace-pre-wrap">{review.customNdaMessage}</p>}
          </div>}
          {!busy && !submission.current && <p>{t('errorReport.notUploaded')}</p>}
          {busy && <output>{review.file ? uploaded === review.file.size ? t('errorReport.verifying') : t('errorReport.progress', { done: uploaded, total: review.file.size }) : t('errorReport.sending')}</output>}
          {error && <p role="alert">{t('errorReport.failed', { reason: error })}</p>}
          <div className="flex gap-2">
            <Button disabled={busy} onClick={send}>{t(error ? 'errorReport.retry' : 'errorReport.submit')}</Button>
            {!submission.current && <Button variant="outline" disabled={busy} onClick={() => setReview(undefined)}>{t('errorReport.edit')}</Button>}
          </div>
        </div>}
        <Button variant="outline" onClick={() => { void cancel(); }}>{t('errorReport.cancel')}</Button>
      </>}
    </DialogContent>
  </Dialog>;
}
