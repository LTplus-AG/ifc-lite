/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { realPublicReportFixture, reporterFixtureSha, sha256 } from '../../../../report-service/test/public-ui.fixture.js';
import { ReportClient } from '@/services/error-reports/client';
import { ErrorReportDialog } from './ErrorReportDialog';

const enabled = process.env.REPORT_TEST_PUBLIC_UI === 'true';
async function until(condition: () => boolean, label: string, diagnostics: () => string = () => '') {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `${label}: ${document.querySelector('[role="alert"]')?.textContent ?? 'deadline'} ${diagnostics()}`);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  }
}
function button(text: string) {
  const node = [...document.querySelectorAll('button')].find(element => element.textContent === text);
  assert.ok(node, `button ${text}`); return node;
}
function input(prefix: string) {
  const node = [...document.querySelectorAll('label')].find(element => element.textContent?.trim().startsWith(prefix))?.querySelector('input');
  assert.ok(node, `input ${prefix}`); return node;
}

test('#7495 mounted public opt-in transfers authentic IFC over real HTTP/PG/S3 and confirmed withdrawal preserves private bytes',
  { skip: !enabled, timeout: 90_000 }, async () => {
    assert.ok(process.env.REPORT_TEST_PUBLIC_UI_IFC_FILE, 'Mandatory authentic reporter fixture path');
    const bytes = await readFile(process.env.REPORT_TEST_PUBLIC_UI_IFC_FILE);
    assert.equal(bytes.length, 22701);
    assert.equal(sha256(bytes), reporterFixtureSha, 'Exact reporter fixture, not synthetic model bytes');
    const fixture = await realPublicReportFixture();
    try {
      render(<ErrorReportDialog context={{ errorCode: 'qualification_load_failed',
        sourceFile: new File([new Uint8Array(bytes).buffer], 'reporter-reduced.ifc') }}
        client={new ReportClient(fixture.transport)} onClose={() => {}} />);
      await until(() => fixture.calls.some(call => call.path.endsWith('/session') && call.status === 200) &&
        document.querySelectorAll('label').length > 0, 'session and rendered attachment controls');
      await fixture.assertActiveSession();
      click(input('Use the model from this failed load'));
      assert.equal(input('Maintainer-only model access').checked, true);
      click(input('Allow public model sharing'));
      click(input('I have permission to share this model with'));
      assert.equal(button('Review report').disabled, true);
      for (const label of ['I have authority and the necessary licence', 'I have reviewed the model contents', 'I permit a public download link']) click(input(label));
      assert.equal(button('Review report').disabled, false);
      click(button('Review report'));
      assert.equal(fixture.calls.filter(call => call.method !== 'GET').length, 0, 'No mutation before reviewed Send');
      assert.equal((await fixture.db.query('SELECT count(*) n FROM model_reports')).rows[0].n, '0');
      assert.equal((await fixture.db.query('SELECT count(*) n FROM report_uploads')).rows[0].n, '0');
      await fixture.assertNoTransferredObjects();
      click(button('Send report'));
      await until(() => document.body.textContent?.includes('Public sharing is pending.') === true, 'actual submitted receipt', () => JSON.stringify(fixture.calls));
      const report = await fixture.report(); const upload = await fixture.upload();
      assert.equal(report.status, 'submitted');
      assert.ok(fixture.calls.some(call => call.path.endsWith('/drafts') && call.cookieSent && call.status === 201),
        'Actual draft mutation authenticated with the captured session cookie');
      assert.equal(report.draft.visibility, 'public');
      assert.equal(upload.status, 'ready');
      assert.deepEqual(upload.input.publicSharingConsent, { version: 'public-model-v1', authorityConfirmed: true,
        redistributionReviewed: true, confidentialContentReviewed: true, downloadedCopiesCannotBeRecalled: true, publishDownloadLink: true });
      assert.equal(upload.object_checksum, reporterFixtureSha);
      assert.equal(await fixture.objectHash(upload.object_key), reporterFixtureSha);
      assert.equal((await fixture.db.query('SELECT state FROM report_public_quarantine')).rows[0].state, 'pending');
      assert.equal((await fixture.db.query('SELECT count(*) n FROM report_public_copies')).rows[0].n, '0');
      assert.equal(document.querySelector('a[href*="/public/"]'), null, 'Quarantine exposes no download');
      assert.ok(fixture.calls.some(call => call.path === 'owned-s3-part' && call.method === 'PUT' && call.status === 200));
      assert.ok(fixture.calls.some(call => call.path.endsWith('/complete') && call.status === 200));
      await fixture.controlledReviewAndPublication();
      click(button('Check public model status'));
      await until(() => document.querySelector('a[href*="/public/"]') !== null, 'actual owner receipt refresh');
      const link = document.querySelector('a[href*="/public/"]'); assert.ok(link);
      const path = link.getAttribute('href'); assert.ok(path);
      const copy = await fixture.copy(); assert.equal(copy.state, 'available');
      assert.equal(await fixture.objectHash(copy.object_key), reporterFixtureSha);
      const response = await fixture.transport(path, { credentials: 'omit' });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-disposition'), 'attachment; filename="model.ifc"');
      assert.equal(sha256(new Uint8Array(await response.arrayBuffer())), reporterFixtureSha);
      await fixture.drain();
      assert.equal((await fixture.db.query('SELECT count(*) n FROM report_public_download_leases')).rows[0].n, '0');
      click(button('Stop public model sharing'));
      assert.equal(fixture.calls.filter(call => call.method === 'DELETE').length, 0, 'First click asks for confirmation');
      click(button('Confirm stop public sharing'));
      await until(() => document.body.textContent?.includes('New downloads are blocked') === true, 'actual withdrawal receipt');
      assert.equal(document.querySelector('a[href*="/public/"]'), null);
      assert.equal(fixture.calls.filter(call => call.method === 'DELETE' && call.path.endsWith('/public-model') && call.status === 200).length, 1);
      assert.equal((await fixture.transport(path, { credentials: 'omit' })).status, 404, 'Fresh anonymous download denied');
      assert.equal((await fixture.report()).status, 'published', 'Support report survives');
      assert.ok(document.querySelector('a[href="https://github.com/LTplus-AG/ifc-lite/issues/7495"]'), 'Controlled issue link survives');
      assert.equal((await fixture.upload()).status, 'ready', 'Private model survives');
      await fixture.cleanupCopy();
      assert.equal(await fixture.objectHash(upload.object_key), reporterFixtureSha, 'Copy erasure preserves exact private original');
    } finally { cleanup(); await fixture.close(); }
  });
