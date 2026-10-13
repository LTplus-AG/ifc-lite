/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import type { ReportSession } from '@ifc-lite/report-contract';
import { ReportClient } from '@/services/error-reports/client';
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
