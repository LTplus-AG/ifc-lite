/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { createServer } from 'node:http';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import type { ReportSession } from '@ifc-lite/report-contract';
import { ReportClient } from '@/services/error-reports/client';
import { forgetReport, pendingReport, recentReport, rememberReport } from '@/lib/error-reports/pending';
import { checksum } from '@/services/error-reports/upload';
import { ErrorReportDialog } from './ErrorReportDialog';
import { emptyAttachment, validAttachment } from './ReportAttachment';

const session: ReportSession = {
  storage: { provider: 'Test storage', location: 'Switzerland', retentionDays: 30, deletionDays: 1, publicSharingEnabled: false, backupDisclosure: 'No backups in test' },
  csrfToken: 'csrf', limits: { maxFileBytes: 1000, partBytes: 4, maxParallelParts: 1, retentionDays: 30 },
  agreement: { version: 'draft', sha256: 'a'.repeat(64), text: 'Agreement text', issuer: 'LTplus AG', jurisdiction: 'Switzerland', signingEnabled: false },
};
afterEach(cleanup);
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
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

test('#7495 queued receipt polls to the GitHub link without another draft or submission', async () => {
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
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); });
  const link = document.querySelector('a[href="https://github.com/LTplus-AG/ifc-lite/issues/7495"]');
  assert.ok(link);
  assert.deepEqual(requests, ['/api/reports/session', '/api/reports/saved-report', '/api/reports/saved-report']);
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

test('#7495 publication hold stops automatic polling but preserves manual status checks', async () => {
  let reads = 0;
  const transport: typeof fetch = async value => {
    if (String(value).endsWith('/session')) return Response.json(session);
    reads++;
    return Response.json({ id: 'held-report', status: 'submitted', ...(reads > 1 ? { publicationHold: 'review_required' } : {}) });
  };
  render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'held-report' }} onClose={() => {}} client={new ReportClient(transport)} />);
  await settle();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); });
  assert.equal(reads, 2);
  assert.ok(document.body.textContent?.includes('Publication is paused for review'));
  assert.ok(!document.body.textContent?.includes('Creating the GitHub issue'));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); });
  assert.equal(reads, 2, 'held report causes no further automatic status request');
  click(button('Check review status'));
  await settle();
  assert.equal(reads, 3, 'manual status check remains available');
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

test('#7495 closing an unavailable recovery does not delete the existing report', async () => {
  const methods: string[] = []; let closes = 0;
  const transport: typeof fetch = async (value, options) => {
    methods.push(options?.method ?? 'GET');
    return String(value).endsWith('/session') ? Response.json(session) : Response.json({ message: 'Temporarily unavailable' }, { status: 503 });
  };
  render(<ErrorReportDialog context={{ errorCode: 'report_resume', resumeReportId: 'owned-report' }} onClose={() => { closes++; }} client={new ReportClient(transport)} />);
  await settle();
  click(button('Close')); await settle();
  assert.equal(closes, 1);
  assert.deepEqual(methods, ['GET', 'GET']);
});

for (const [status, code] of [[404, 'report_missing'], [503, 'service_unavailable']] as const) {
  test(`#7500 closing recovery after ${status} preserves data and only forgets a known missing report`, async () => {
    const methods: string[] = []; let closes = 0;
    rememberReport('stale-recovery');
    const server = createServer((request, response) => {
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
      await settle(); click(button('Close')); await settle();
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
    click(button('Review report')); click(button('Send report')); await settle();
    assert.ok(document.body.textContent?.includes('selected model differs'));
    assert.deepEqual(writes, []);
  } finally { forgetReport('resume-source'); }
});
