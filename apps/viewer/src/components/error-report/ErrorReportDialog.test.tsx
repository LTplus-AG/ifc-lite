/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { settleReportWork as settle, reportClock } from '@/test/error-report-timing.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import type { ReportReceipt, ReportSession } from '@ifc-lite/report-contract';
import { ReportClient } from '@/services/error-reports/client';
import { forgetReport, pendingReport, recentReport, rememberReport } from '@/lib/error-reports/pending';
import { checksum } from '@/services/error-reports/upload';
import { ReportSubmission } from '@/services/error-reports/submission';
import { ErrorReportHost } from './ErrorReportHost';
import { ErrorReportDialog } from './ErrorReportDialog';
import { emptyAttachment, validAttachment } from './ReportAttachment';

const session: ReportSession = {
  storage: { provider: 'Test storage', location: 'Switzerland', retentionDays: 30, deletionDays: 1, publicSharingEnabled: false, backupDisclosure: 'No backups in test' },
  csrfToken: 'csrf', limits: { maxFileBytes: 1000, partBytes: 4, maxParallelParts: 1, retentionDays: 30 },
  agreement: { version: 'draft', sha256: 'a'.repeat(64), text: 'Agreement text', issuer: 'LTplus AG', jurisdiction: 'Switzerland', signingEnabled: false },
};
afterEach(cleanup);
function fixtureCors(request: IncomingMessage, response: ServerResponse): boolean {
  response.setHeader('Access-Control-Allow-Origin', window.location.origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return false; }
  return true;
}
async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await settle();
  assert.ok(check(), message);
}
function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find(element => element.textContent === text);
  assert.ok(result, `button ${text}`); return result;
}
function input(label: string): HTMLInputElement {
  const result = [...document.querySelectorAll('label')].find(element => element.textContent?.trim().startsWith(label))?.querySelector('input');
  assert.ok(result); return result;
}
function enter(element: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('#7495 report UI sends no model or draft before reviewed Send and excludes private filename', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const transport: typeof fetch = async (value, options) => {
    const path = String(value); calls.push({ path, method: options?.method ?? 'GET', body: typeof options?.body === 'string' ? JSON.parse(options.body) : undefined });
    if (path.endsWith('/session')) return Response.json(session);
    if (path.endsWith('/drafts')) return Response.json({ id: 'report-1', status: 'draft' });
    if (path.endsWith('/submit')) return Response.json({ id: 'report-1', status: 'submitted', issueUrl: 'https://github.com/LTplus-AG/ifc-lite/issues/7495' });
    throw new Error(`Unexpected request: ${path}`);
  };
  render(<ErrorReportDialog context={{ errorCode: 'load_failed', sourceFile: new File(['private'], 'secret-project.ifc') }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle();
  assert.equal(input('Use the model from this failed load').checked, false);
  enter(input('Report title'), 'Viewer stopped after loading');
  click(button('Review report'));
  await settle();
  assert.equal(calls.length, 1, 'review performs no mutation');
  assert.ok(document.body.textContent?.includes('No model attached'));
  click(button('Send report'));
  await settle();
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'POST']);
  assert.ok(!JSON.stringify(calls).includes('secret-project.ifc'));
  assert.ok(document.body.textContent?.includes('Report reference: report-1'));
});

test('#7495 optional NDA does not prevent purpose-bound private upload, while public and standard require consent', () => {
  const file = new File(['ifc'], 'source.ifc');
  assert.equal(validAttachment({ ...emptyAttachment, file }, session), false);
  assert.equal(validAttachment({ ...emptyAttachment, file, uploadConsent: true }, session), true);
  assert.equal(validAttachment({ ...emptyAttachment, file, uploadConsent: true, visibility: 'public' }, session), false);
  assert.equal(validAttachment({ ...emptyAttachment, file, uploadConsent: true, visibility: 'public', publicConfirmed: true }, session), false);
  assert.equal(validAttachment({ ...emptyAttachment, file, uploadConsent: true, confidentiality: 'standard', accepted: true, signerName: 'User', signerEmail: 'user@example.test', organization: 'Company' }, session), false);
  assert.equal(validAttachment({ ...emptyAttachment, file, confidentiality: 'custom', customMessage: 'Please email me privately.' }, session), true);
});

test('#7495 selecting and reviewing a private attachment still sends zero model bytes', async () => {
  const calls: string[] = [];
  const transport: typeof fetch = async (value, options) => { calls.push(`${options?.method}:${String(value)}`); return Response.json(session); };
  render(<ErrorReportDialog context={{ errorCode: 'geometry_processing', sourceFile: new File(['model bytes'], 'confidential.ifc') }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle();
  enter(input('Report title'), 'Model load failed');
  click(input('Use the model from this failed load'));
  click(input('I have permission to share this model'));
  click(button('Review report'));
  await settle();
  assert.ok(document.body.textContent?.includes('Review before sending'));
  assert.ok(document.body.textContent?.includes('confidential.ifc'));
  assert.deepEqual(calls, ['GET:/api/reports/session']);
});

test('#7495 queued receipt polls to the GitHub link without another draft or submission', async t => {
  const clock = reportClock(t);
  const requests: string[] = [];
  let statusReads = 0;
  const transport: typeof fetch = async value => {
    const path = String(value); requests.push(path);
    if (path.endsWith('/session')) return Response.json(session);
    assert.equal(path, '/api/reports/saved-report');
    statusReads++;
    return Response.json(statusReads === 1 ? { id: 'saved-report', status: 'submitted' } : { id: 'saved-report', status: 'published', issueUrl: 'https://github.com/LTplus-AG/ifc-lite/issues/7495' });
  };
  render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'saved-report' }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle();
  assert.ok(document.body.textContent?.includes('Creating the GitHub issue'));
  await clock.advance(2999);
  assert.equal(statusReads, 1, 'publication is not polled before three seconds');
  await clock.advance(1);
  const link = document.querySelector('a[href="https://github.com/LTplus-AG/ifc-lite/issues/7495"]');
  assert.ok(link);
  assert.deepEqual(requests, ['/api/reports/session', '/api/reports/saved-report', '/api/reports/saved-report']);
  await clock.advance(6000);
  assert.equal(statusReads, 2, 'published receipt stops automatic polling');
});

test('#7495 known errors prefill an editable plain-language title while the description stays optional', async () => {
  const transport: typeof fetch = async () => Response.json(session);
  for (const [errorCode, expected] of [['load_failed', 'Problem loading a model'], ['gpu_device_lost', 'Problem displaying the model'], ['unhandled_viewer_error', 'Problem using IFC Lite']]) {
    render(<ErrorReportDialog context={{ errorCode: errorCode! }} onClose={() => {}} client={new ReportClient(transport)} />);
    await settle();
    assert.equal(input('Report title').value, expected);
    enter(input('Report title'), 'My own description of the problem');
    click(button('Review report'));
    await settle();
    assert.ok(document.body.textContent?.includes('My own description of the problem'));
    assert.ok(document.body.textContent?.includes('Send report'), 'description may remain empty');
    cleanup();
  }
});

test('#7495 publication hold stops automatic polling but preserves manual status checks', async t => {
  const clock = reportClock(t);
  let reads = 0;
  const transport: typeof fetch = async value => {
    if (String(value).endsWith('/session')) return Response.json(session);
    reads++;
    return Response.json({ id: 'held-report', status: 'submitted', ...(reads > 1 ? { publicationHold: 'review_required' } : {}) });
  };
  render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'held-report' }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle();
  assert.equal(reads, 1, 'recovery completes before the polling clock advances');
  await clock.advance(3000);
  assert.equal(reads, 2);
  assert.ok(document.body.textContent?.includes('Publication is paused for review'));
  assert.ok(!document.body.textContent?.includes('Creating the GitHub issue'));
  await clock.advance(6000);
  assert.equal(reads, 2, 'held report causes no further automatic status request');
  click(button('Check review status'));
  await settle();
  assert.equal(reads, 3, 'manual status check remains available');
});

test('#7495 publication polling waits for each response and unmount aborts the pending request', async t => {
  const clock = reportClock(t);
  rememberReport('polling-report');
  const requests: string[] = [];
  let reads = 0;
  let pollSignal: AbortSignal | null | undefined;
  let finish!: (response: Response) => void;
  let pending = new Promise<Response>(resolve => { finish = resolve; });
  t.after(async () => {
    cleanup();
    await act(async () => { finish(Response.json({ id: 'polling-report', status: 'submitted' })); await pending; });
    forgetReport('polling-report');
  });
  const transport: typeof fetch = async (value, options) => {
    const path = String(value); requests.push(`${options?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/session')) return Response.json(session);
    reads++;
    if (reads === 1) return Response.json({ id: 'polling-report', status: 'submitted' });
    pollSignal = options?.signal;
    return pending; // Deliberately ignores abort so late-completion guards matter.
  };
  render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'polling-report' }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle();
  assert.equal(reads, 1);
  await clock.advance(3000);
  assert.equal(reads, 2, 'first poll is in flight');
  assert.ok(pollSignal);
  assert.equal(pollSignal.aborted, false);
  await clock.advance(9000);
  assert.equal(reads, 2, 'slow status requests never overlap');
  await act(async () => { finish(Response.json({ id: 'polling-report', status: 'submitted' })); await pending; });
  pending = new Promise<Response>(resolve => { finish = resolve; });
  await clock.advance(2999);
  assert.equal(reads, 2, 'next interval starts when the prior request completes');
  await clock.advance(1);
  assert.equal(reads, 3);
  assert.equal(pollSignal.aborted, false);
  cleanup();
  assert.equal(pollSignal.aborted, true, 'unmount aborts the in-flight poll');
  await act(async () => { finish(Response.json({ id: 'polling-report', status: 'published', issueUrl: 'https://github.com/LTplus-AG/ifc-lite/issues/7495' })); await pending; });
  assert.equal(pendingReport(), 'polling-report', 'late publication cannot complete an unmounted report');
  await clock.advance(6000);
  assert.equal(reads, 3, 'unmount cancels future polling');
  assert.deepEqual(requests, ['GET /api/reports/session', ...Array<string>(3).fill('GET /api/reports/polling-report')]);
});

test('#7495 unmount clears a scheduled publication poll before it can request status', async t => {
  const clock = reportClock(t);
  let reads = 0;
  t.after(() => forgetReport('scheduled-report'));
  const client = new ReportClient(async value => {
    if (String(value).endsWith('/session')) return Response.json(session);
    reads++;
    return Response.json({ id: 'scheduled-report', status: 'submitted' });
  });
  render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'scheduled-report' }} onClose={() => {}} client={client} />);
  await settle();
  assert.equal(reads, 1, 'initial recovery completed');
  cleanup();
  await clock.advance(6000);
  assert.equal(reads, 1, 'a cancelled timer never calls even an abort-ignoring transport');
});

test('#7495 custom NDA receipt identifies a request rather than a submitted error report', async () => {
  const transport: typeof fetch = async value => Response.json(String(value).endsWith('/session') ? session : { id: 'nda-request', status: 'manual_review' });
  render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'nda-request' }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle();
  assert.ok(document.body.textContent?.includes('Your NDA review request has been received'));
  assert.ok(document.body.textContent?.includes('No model was uploaded'));
  assert.ok(!document.body.textContent?.includes('Your report has been received'));
});


test('#7495 standard NDA review shows signer and version without displaying its technical digest', async () => {
  const signingSession = { ...session, agreement: { ...session.agreement, signingEnabled: true } };
  render(<ErrorReportDialog context={{ errorCode: 'load_failed', sourceFile: new File(['ifc'], 'private.ifc') }} onClose={() => {}} client={new ReportClient(async () => Response.json(signingSession))} />);
  await settle();
  click(input('Use the model from this failed load'));
  const select = document.querySelector('select');
  assert.ok(select);
  act(() => { select.value = 'standard'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  enter(input('Your full name'), 'Model Owner');
  enter(input('Your email'), 'owner@example.test');
  enter(input('Your organization'), 'Example Company');
  click(input('I have authority to share this model'));
  click(input('I have permission to share this model'));
  click(button('Review report'));
  await settle();
  assert.ok(document.body.textContent?.includes('Model Owner'));
  assert.ok(document.body.textContent?.includes('owner@example.test'));
  assert.ok(document.body.textContent?.includes(signingSession.agreement.version));
  assert.ok(!document.body.textContent?.includes(signingSession.agreement.sha256));
});

test('#7495 deleting private data requires confirmation and preserves the public issue link', async () => {
  const methods: string[] = [];
  const transport: typeof fetch = async (value, options) => {
    methods.push(options?.method ?? 'GET');
    if (String(value).endsWith('/session')) return Response.json(session);
    return Response.json(options?.method === 'DELETE' ? { id: 'owned-report', status: 'deleted' } : { id: 'owned-report', status: 'published', issueUrl: 'https://github.com/LTplus-AG/ifc-lite/issues/7495' });
  };
  render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'owned-report' }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle();
  click(button('Delete private report and model'));
  assert.ok(document.body.textContent?.includes('already published or being published remains public'));
  assert.equal(methods.filter(method => method === 'DELETE').length, 0);
  click(button('Keep report'));
  assert.equal(methods.filter(method => method === 'DELETE').length, 0);
  click(button('Delete private report and model'));
  click(button('Confirm deletion of private data'));
  await settle();
  assert.equal(methods.filter(method => method === 'DELETE').length, 1);
  assert.ok(document.body.textContent?.includes('Private data deletion confirmed'));
  assert.ok(document.querySelector('a[href="https://github.com/LTplus-AG/ifc-lite/issues/7495"]'));
  assert.equal([...document.querySelectorAll('button')].some(element => element.textContent === 'Delete private report and model'), false);
});

test('#7495 a deletion failure remains retryable and never claims completion', async () => {
  let deletions = 0;
  const transport: typeof fetch = async (value, options) => {
    if (String(value).endsWith('/session')) return Response.json(session);
    if (options?.method === 'DELETE') {
      deletions++;
      return deletions === 1 ? Response.json({ message: 'Storage unavailable. Please retry.' }, { status: 503 }) : Response.json({ id: 'owned-report', status: 'deleted' });
    }
    return Response.json({ id: 'owned-report', status: 'published' });
  };
  render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'owned-report' }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle();
  click(button('Delete private report and model')); click(button('Confirm deletion of private data'));
  await settle();
  assert.ok(document.body.textContent?.includes('Storage unavailable. Please retry.'));
  assert.equal(document.body.textContent?.includes('Private data deletion confirmed'), false);
  click(button('Confirm deletion of private data')); await settle();
  assert.equal(deletions, 2);
  assert.ok(document.body.textContent?.includes('Private data deletion confirmed'));
});



for (const [status, code] of [[404, 'report_missing'], [503, 'service_unavailable']] as const) {
  test(`#7500 closing recovery after ${status} preserves data and only forgets a known missing report`, async () => {
    const methods: string[] = []; let closes = 0;
    rememberReport('stale-recovery');
    const server = createServer((request, response) => {
    if (!fixtureCors(request, response)) return;
      methods.push(request.method ?? 'GET');
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.endsWith('/session')) response.end(JSON.stringify(session));
      else { response.statusCode = status; response.end(JSON.stringify({ error: code, message: 'Unavailable' })); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const transport: typeof fetch = (value, options) => fetch(endpoint + String(value), options);
    try {
      render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'stale-recovery' }} onClose={() => { closes++; }} client={new ReportClient(transport)} />);
      await waitFor(() => methods.length === 2 && !!document.querySelector('output')?.textContent?.includes('Reporting is unavailable right now'), 'unavailable recovery completes its actual request'); click(button('Close')); await waitFor(() => closes === 1, 'recovery closes');
      assert.equal(closes, 1); assert.deepEqual(methods, ['GET', 'GET']);
      assert.equal(pendingReport(), status === 404 ? undefined : 'stale-recovery');
      assert.equal(recentReport(), status === 404 ? undefined : 'stale-recovery');
    } finally { forgetReport('stale-recovery'); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test('#7500 Escape and outside pointer events while sending cannot abort or delete the report', async () => {
  let closes = 0, deletes = 0;
  let finish!: (response: Response) => void;
  const accepted = new Promise<Response>(resolve => { finish = resolve; });
  let submitSignal: AbortSignal | undefined;
  const transport: typeof fetch = async (value, options) => {
    const path = String(value);
    if (path.endsWith('/session')) return Response.json(session);
    if (options?.method === 'DELETE') { deletes++; return Response.json({ id: 'busy-report', status: 'deleted' }); }
    if (path.endsWith('/drafts')) return Response.json({ id: 'busy-report', status: 'draft' });
    if (path.endsWith('/submit')) { submitSignal = options?.signal ?? undefined; return accepted; }
    throw new Error('Unexpected request');
  };
  try {
    render(<ErrorReportDialog context={{ errorCode: 'load_failed' }} onClose={() => { closes++; }} client={new ReportClient(transport)} />);
    await settle(); click(button('Review report')); click(button('Send report')); await settle();
    assert.ok(submitSignal);
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    act(() => {
      // Radix completes an outside pointer gesture on click; do not leave a
      // half-gesture pending until the later explicit Close button.
      document.body.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    assert.equal(submitSignal.aborted, false); assert.equal(deletes, 0); assert.equal(closes, 0);
    finish(Response.json({ id: 'busy-report', status: 'submitted' })); await settle();
    assert.equal(closes, 0, 'ignored busy interactions cannot close after completion');
    click(button('Close')); await settle();
    assert.equal(closes, 1); assert.equal(deletes, 0); assert.equal(pendingReport(), 'busy-report');
  } finally { finish(Response.json({ id: 'busy-report', status: 'submitted' })); await settle(); forgetReport('busy-report'); }
});

test('#7500 resumed completed upload rejects a same-name same-size model with different bytes before submission', async () => {
  const writes: string[] = []; let uploadReads = 0;
  const upload = { id: 'upload', status: 'verifying', partBytes: 4, partCount: 1, uploadedParts: [], sourceParts: [{ partNumber: 1, size: 4, sha256: await checksum(new TextEncoder().encode('real').buffer) }] };
  const transport: typeof fetch = async (value, options) => {
    const path = String(value);
    if (options?.method !== 'GET') writes.push(path);
    if (path.endsWith('/session')) return Response.json(session);
    if (path.includes('/uploads/')) return Response.json({ ...upload, status: ++uploadReads > 1 ? 'ready' : 'verifying' });
    if (path.endsWith('/submit')) return Response.json({ id: 'resume-source', status: 'submitted' });
    return Response.json({ id: 'resume-source', status: 'draft', upload, uploadSource: { name: 'same.ifc', size: 4, confidentiality: 'none' }, draft: { clientRequestId: 'request', title: 'Reviewed source', description: '', diagnostics: { errorCode: 'load_failed', appVersion: 'test', buildSha: 'test' }, visibility: 'private' } });
  };
  try {
    render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'resume-source' }} onClose={() => {}} client={new ReportClient(transport)} />);
    await settle();
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(fileInput);
    Object.defineProperty(fileInput, 'files', { value: [new File(['fake'], 'same.ifc')], configurable: true });
    act(() => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    click(button('Review report')); click(button('Send report'));
    await waitFor(() => !!document.body.textContent?.includes('selected model differs'), 'real source checksum rejects the replacement');
    assert.ok(document.body.textContent?.includes('selected model differs'));
    assert.deepEqual(writes, []);
  } finally { forgetReport('resume-source'); }
});


test('#7500 cancelling an older failed submission deletes only its own recovery reference', async () => {
  const draft = { clientRequestId: 'old-request', title: 'Older report', description: '', diagnostics: { errorCode: 'load_failed', appVersion: 'test', buildSha: 'test' }, visibility: 'private' as const };
  const deleted: string[] = []; let closes = 0;
  const server = createServer((request, response) => {
    if (!fixtureCors(request, response)) return;
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.endsWith('/session')) response.end(JSON.stringify(session));
    else if (request.method === 'DELETE') { deleted.push(request.url ?? ''); response.end(JSON.stringify({ id: request.url?.split('/').at(-1), status: 'deleted' })); }
    else if (request.url?.endsWith('/older-report/submit')) { response.statusCode = 503; response.end(JSON.stringify({ error: 'service_unavailable', message: 'Retry later' })); }
    else if (request.url?.endsWith('/drafts')) response.end(JSON.stringify({ id: 'newer-report', status: 'draft' }));
    else if (request.url?.endsWith('/newer-report/submit')) response.end(JSON.stringify({ id: 'newer-report', status: 'submitted' }));
    else response.end(JSON.stringify({ id: 'older-report', status: 'draft', draft }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ReportClient((value, options) => fetch(`http://127.0.0.1:${address.port}` + String(value), options));
  try {
    render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'older-report' }} onClose={() => { closes++; }} client={client} />);
    await waitFor(() => [...document.querySelectorAll('button')].some(item => item.textContent === 'Review report'), 'owned draft restores');
    click(button('Review report')); click(button('Send report'));
    await waitFor(() => !!document.body.textContent?.includes('Retry later'), 'failed send remains cancellable');
    const newer = new ReportSubmission({ draft: { ...draft, clientRequestId: 'new-request', title: 'Newer report' }, confidentiality: 'none', publicModelConfirmed: false }, client);
    await newer.send(new AbortController().signal, () => {});
    assert.equal(pendingReport(), 'newer-report');
    click(button('Cancel and delete draft')); await waitFor(() => closes === 1, 'older report cancellation completes');
    assert.deepEqual(deleted, ['/api/reports/older-report']); assert.equal(closes, 1);
    assert.equal(pendingReport(), 'newer-report'); assert.equal(recentReport(), 'newer-report');
    cleanup(); render(<ErrorReportHost />);
    assert.ok(document.body.textContent?.includes('View recent report'));
    const confirmedDeleted = await client.request<ReportReceipt>('/newer-report', 'DELETE');
    await act(async () => { await new ReportSubmission(newer.reviewed, client, confirmedDeleted).cancel(); });
    assert.equal(pendingReport(), undefined); assert.equal(recentReport(), undefined);
    assert.deepEqual(deleted, ['/api/reports/older-report', '/api/reports/newer-report'], 'known deleted cancellation makes no further DELETE');

  } finally {
    act(() => { forgetReport('older-report'); forgetReport('newer-report'); });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


for (const mode of ['automatic publication', 'manual status refresh'] as const) test(`#7500 older ${mode} keeps a newer pending report recoverable`, async t => {
  const clock = reportClock(t);
  const draft = { clientRequestId: 'request', title: 'Reviewed report', description: '', diagnostics: { errorCode: 'load_failed', appVersion: 'test', buildSha: 'test' }, visibility: 'private' as const };
  let published = false;
  const server = createServer((request, response) => {
    if (!fixtureCors(request, response)) return;
    const id = request.url?.startsWith('/A/') ? 'pub-A' : 'pub-B';
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.endsWith('/session')) response.end(JSON.stringify(session));
    else if (request.url?.endsWith('/drafts')) response.end(JSON.stringify({ id, status: 'draft' }));
    else if (request.url?.endsWith('/submit')) response.end(JSON.stringify({ id, status: 'submitted' }));
    else response.end(JSON.stringify({ id, status: id === 'pub-A' && published ? 'published' : 'submitted', ...(id === 'pub-A' && published ? { issueUrl: 'https://github.com/LTplus-AG/ifc-lite/issues/7495' } : {}) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = (scope: string) => new ReportClient((value, options) => fetch(`http://127.0.0.1:${address.port}/${scope}` + String(value), options));
  const oldClient = client('A'), newClient = client('B');
  try {
    await oldClient.session();
    await new ReportSubmission({ draft, confidentiality: 'none', publicModelConfirmed: false }, oldClient).send(new AbortController().signal, () => {});
    render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'pub-A' }} onClose={() => {}} client={oldClient} />);
    await waitFor(() => [...document.querySelectorAll('button')].some(item => item.textContent === 'Check review status'), 'older report restores'); await newClient.session();
    await new ReportSubmission({ draft: { ...draft, clientRequestId: 'new-request' }, confidentiality: 'none', publicModelConfirmed: false }, newClient).send(new AbortController().signal, () => {});
    published = true;
    if (mode === 'automatic publication') await clock.advance(3000);
    else click(button('Check review status'));
    await waitFor(() => !!document.querySelector('a[href="https://github.com/LTplus-AG/ifc-lite/issues/7495"]'), 'older publication reaches its link');
    assert.ok(document.querySelector('a[href="https://github.com/LTplus-AG/ifc-lite/issues/7495"]'));
    assert.equal(pendingReport(), 'pub-B'); assert.equal(recentReport(), 'pub-B');
  } finally {
    act(() => { forgetReport('pub-A'); forgetReport('pub-B'); });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('#7495 exact issue match requires explicit destination review and never silently falls back', async () => {
  const correlation = { eventId: crypto.randomUUID(), sessionId: crypto.randomUUID(), buildSha: 'dev' };
  const target = { issueUrl: 'https://github.com/LTplus-AG/ifc-lite/issues/7493', title: 'Known selection crash', verificationToken: 'signed-owner-bound-target' };
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const transport: typeof fetch = async (url, init) => {
    const path = String(url);
    calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path.endsWith('/session')) return Response.json({ ...session, issueLinkingEnabled: true });
    if (path.endsWith('/resolve-issue')) return Response.json({ status: 'matched', target });
    if (path.endsWith('/drafts')) return Response.json({ id: 'reviewed-report', status: 'draft' });
    if (path.endsWith('/submit')) return Response.json({ id: 'reviewed-report', status: 'published', issueUrl: target.issueUrl });
    throw new Error('Unexpected request');
  };
  render(<ErrorReportDialog context={{ errorCode: 'renderer_frame_failed', correlation }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle();
  assert.equal(calls.length, 1, 'no automatic correlation lookup or report creation');
  assert.equal(button('Review report').disabled, true);
  click(button('Check for an existing issue')); await settle();
  assert.deepEqual(calls[1]?.body, correlation);
  assert.equal(button('Review report').disabled, true, 'a match does not choose for the user');
  const existing = [...document.querySelectorAll('label')].find(label => label.textContent?.includes('Add my reviewed report to'))?.querySelector('input');
  assert.ok(existing); click(existing);
  click(button('Review report'));
  assert.ok(document.body.textContent?.includes(target.issueUrl));
  assert.equal(calls.length, 2, 'review still sends no report/model');
  click(button('Send report')); await settle();
  const draft = calls.find(call => call.path.endsWith('/drafts'))?.body;
  assert.deepEqual(draft?.issueTarget, target);
  assert.ok(!JSON.stringify(draft?.diagnostics).includes(correlation.sessionId));
  assert.equal(calls.filter(call => call.path.endsWith('/drafts')).length, 1);
});

test('#7495 unavailable issue lookup requires an explicit new-issue choice', async () => {
  const transport: typeof fetch = async (url) => String(url).endsWith('/session')
    ? Response.json({ ...session, issueLinkingEnabled: true }) : Response.json({ status: 'unavailable' });
  render(<ErrorReportDialog context={{ errorCode: 'renderer_frame_failed', correlation: { eventId: crypto.randomUUID(), sessionId: crypto.randomUUID(), buildSha: 'dev' } }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle(); click(button('Check for an existing issue')); await settle();
  assert.equal(button('Review report').disabled, true);
  assert.ok(document.body.textContent?.includes('could not be verified'));
  const separate = [...document.querySelectorAll('label')].find(label => label.textContent?.includes('Create a separate GitHub issue'))?.querySelector('input');
  assert.ok(separate); click(separate);
  assert.equal(button('Review report').disabled, false);
});
