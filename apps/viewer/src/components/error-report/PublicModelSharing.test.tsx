/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { settleReportWork as settle } from '@/test/error-report-timing.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import type { PublicSharingConsent, ReportSession } from '@ifc-lite/report-contract';
import { ReportClient } from '@/services/error-reports/client';
import * as reportLinks from '@/services/error-reports/client';
import { ErrorReportDialog } from './ErrorReportDialog';
import { emptyAttachment, validAttachment } from './ReportAttachment';

const session: ReportSession = {
  storage: { provider: 'Test storage', location: 'Development fixture', retentionDays: 30, deletionDays: 7, publicSharingEnabled: true, publicMaxFileBytes: 1024 ** 3, backupDisclosure: 'Fixture has no backups' },
  csrfToken: 'csrf', limits: { maxFileBytes: 2 * 1024 ** 3, partBytes: 4, maxParallelParts: 1, retentionDays: 30 },
  agreement: { version: 'draft', sha256: 'a'.repeat(64), text: 'Draft', issuer: 'LTplus AG', jurisdiction: 'Switzerland', signingEnabled: false },
};
const consent: PublicSharingConsent = { version: 'public-model-v1', authorityConfirmed: true, redistributionReviewed: true,
  confidentialContentReviewed: true, downloadedCopiesCannotBeRecalled: true, publishDownloadLink: true };
afterEach(cleanup);
function button(text: string) {
  const element = [...document.querySelectorAll('button')].find(node => node.textContent === text);
  assert.ok(element, `button ${text}`); return element;
}
function input(prefix: string) {
  const element = [...document.querySelectorAll('label')].find(node => node.textContent?.trim().startsWith(prefix))?.querySelector('input');
  assert.ok(element, `input ${prefix}`); return element;
}

test('#7495 public opt-in needs distinct permissions, preserves private default, and sends reviewed consent only after Send', async () => {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const client = new ReportClient(async (value, options) => {
    const path = String(value); calls.push({ path, method: options?.method ?? 'GET', body: typeof options?.body === 'string' ? JSON.parse(options.body) : undefined });
    if (path.endsWith('/session')) return Response.json(session);
    if (path.endsWith('/drafts')) return Response.json({ id: 'public-report', status: 'draft' });
    // Observe the actual upload authorization request, then hold before any bytes.
    return Response.json({ message: 'Qualification stopped before transfer.' }, { status: 503 });
  });
  render(<ErrorReportDialog context={{ errorCode: 'load_failed', sourceFile: new File(['ifc'], 'private-project.ifc') }} client={client} onClose={() => {}} />);
  await settle();
  click(input('Use the model from this failed load'));
  assert.equal(input('Maintainer-only model access').checked, true);
  click(input('Allow public model sharing'));
  click(input('I have permission to share this model with'));
  assert.equal(button('Review report').disabled, true);
  click(input('I have authority and the necessary licence'));
  click(input('I have reviewed the model contents'));
  assert.equal(button('Review report').disabled, true, 'permission to publish an irreversible public copy is separate');
  click(input('I permit a public download link'));
  click(button('Review report'));
  await settle();
  assert.equal(calls.length, 1, 'review sends no draft, consent or bytes');
  assert.ok(document.body.textContent?.includes('downloaded copies cannot be recalled'));
  click(button('Send report'));
  await settle();
  assert.deepEqual(calls.map(row => row.path), ['/api/reports/session', '/api/reports/drafts', '/api/reports/public-report/uploads']);
  const draft = calls[1]!.body!;
  assert.equal(draft.visibility, 'public');
  assert.ok(!JSON.stringify(draft).includes('private-project.ifc'), 'filename remains outside public issue content');
  assert.deepEqual(calls[2]!.body!.publicSharingConsent, consent);
  assert.equal(calls[2]!.body!.confidentiality, 'none');
});

test('#7495 changing the selected model resets every public permission and public format limits fail closed', async () => {
  render(<ErrorReportDialog context={{ errorCode: 'load_failed', sourceFile: new File(['ifc'], 'source.ifc') }} client={new ReportClient(async () => Response.json(session))} onClose={() => {}} />);
  await settle();
  click(input('Use the model from this failed load'));
  click(input('Allow public model sharing'));
  for (const label of ['I have permission to share this model with', 'I have authority and the necessary licence', 'I have reviewed the model contents', 'I permit a public download link']) click(input(label));
  assert.equal(button('Review report').disabled, false);
  click(input('Use the model from this failed load'));
  click(input('Use the model from this failed load'));
  for (const label of ['I have permission to share this model with', 'I have authority and the necessary licence', 'I have reviewed the model contents', 'I permit a public download link']) assert.equal(input(label).checked, false);
  assert.equal(button('Review report').disabled, true);
  const selected = { ...emptyAttachment, visibility: 'public' as const, file: new File(['ifc'], 'source.ifczip'), uploadConsent: true, publicConfirmed: true, publicPrivacyConfirmed: true, publicCopiesConfirmed: true };
  assert.equal(validAttachment(selected, session), false);
  assert.equal(validAttachment({ ...selected, file: new File(['ifc'], 'source.ifc'), confidentiality: 'standard' }, session), false);
  assert.equal(validAttachment({ ...selected, file: new File(['ifc'], 'source.ifc') }, { ...session, storage: { ...session.storage, publicMaxFileBytes: undefined } }), false);
});

test('#7495 public status refresh and reviewed withdrawal keep the issue and private support report', async () => {
  const calls: { path: string; method: string }[] = [];
  const token = 'a'.repeat(64);
  let reads = 0;
  const client = new ReportClient(async (value, options) => {
    const path = String(value); calls.push({ path, method: options?.method ?? 'GET' });
    if (path.endsWith('/session')) return Response.json(session);
    const shared = { id: 'owned', status: 'published', issueUrl: 'https://github.com/LTplus-AG/ifc-lite/issues/7495' };
    if (options?.method === 'DELETE') return Response.json({ ...shared, publicModel: { state: 'withdrawn' } });
    return Response.json({ ...shared, publicModel: ++reads === 1 ? { state: 'review' } : { state: 'available', downloadUrl: `http://localhost/api/reports/public/${token}` } });
  });
  render(<ErrorReportDialog context={{ errorCode: 'resume', resumeReportId: 'owned' }} client={client} onClose={() => {}} />);
  await settle();
  assert.ok(document.body.textContent?.includes('awaiting a separate privacy'));
  assert.equal(document.querySelector('a[href*="/public/"]'), null);
  click(button('Check public model status'));
  await settle();
  assert.ok(document.querySelector(`a[href="/api/reports/public/${token}"]`));
  click(button('Stop public model sharing'));
  assert.equal(calls.filter(row => row.method === 'DELETE').length, 0);
  assert.ok(document.body.textContent?.includes('private support model and GitHub issue remain'));
  click(button('Confirm stop public sharing'));
  await settle();
  assert.deepEqual(calls.filter(row => row.method === 'DELETE'), [{ path: '/api/reports/owned/public-model', method: 'DELETE' }]);
  assert.equal(document.querySelector('a[href*="/public/"]'), null);
  assert.ok(document.body.textContent?.includes('New downloads are blocked'));
  assert.ok(document.querySelector('a[href="https://github.com/LTplus-AG/ifc-lite/issues/7495"]'));
});

test('#7495 public receipt links cannot exfiltrate through foreign hosts, private paths or query parameters', () => {
  // Namespace lookup lets the production-revert oracle observe an assertion,
  // rather than failing module collection when this new helper is absent.
  const safePublicModelUrl = reportLinks.safePublicModelUrl;
  assert.equal(typeof safePublicModelUrl, 'function', 'Public links need a same-origin delivery boundary');
  const path = `/api/reports/public/${'b'.repeat(64)}`;
  assert.equal(safePublicModelUrl(`https://ifclite.com${path}`, 'https://ifclite.com'), path);
  for (const value of [`https://evil.example${path}`, `${path}?key=private`, `${path}#private`, '/api/reports/private-model', `https://user:password@ifclite.com${path}`, 'javascript:alert(1)']) {
    assert.equal(safePublicModelUrl(value, 'https://ifclite.com'), undefined);
  }
});
