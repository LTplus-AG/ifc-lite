/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { installLayout } from '@/test/dom-layout';
installLayout();
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { cleanup, click, advance } from '@/test/render';
import { settleReportWork } from '@/test/error-report-timing';
import { mountDestinations, searchDestination, destinationOption, namedButton } from '@/test/palette-destinations';
import { dismissErrorReport, getReportPrompt, offerErrorReport } from '@/lib/error-reports/context';
import { completeReport, forgetReport, rememberReport } from '@/lib/error-reports/pending';
import { openErrorReportDestination } from '@/lib/error-reports/destination';
import { useViewerStore } from '@/store';
import { setLocale } from '@/i18n';
import { ErrorReportHost } from './ErrorReportHost';

const initial = useViewerStore.getState();
let host: ReturnType<typeof mountDestinations> | undefined;
let showHost: (show: boolean) => void;
function ToggleHost() {
  const [shown, setShown] = useState(true);
  showHost = setShown;
  return shown ? <ErrorReportHost /> : null;
}
beforeEach(() => { setLocale('en'); localStorage.clear(); dismissErrorReport(); forgetReport('palette-recent'); });
afterEach(async () => {
  cleanup(); await host?.dispose(); host = undefined;
  dismissErrorReport(); forgetReport('palette-recent'); useViewerStore.setState(initial);
});
// Only the HTTP boundary is mocked: real host, palette, SDK context and lazy dialog.
function transport(t: TestContext) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (value: RequestInfo | URL, options?: RequestInit) => {
    const path = String(value), method = options?.method ?? 'GET';
    calls.push({ path, method, body: typeof options?.body === 'string' ? JSON.parse(options.body) : undefined });
    if (path === '/api/reports/session') return Response.json({
      csrfToken: 'test-csrf', issueLinkingEnabled: true,
      storage: { provider: 'Test storage', location: 'Switzerland', retentionDays: 30, deletionDays: 1, publicSharingEnabled: false, backupDisclosure: 'No backups in test' },
      limits: { maxFileBytes: 1000, partBytes: 4, maxParallelParts: 1, retentionDays: 30 },
      agreement: { version: 'test', sha256: 'a'.repeat(64), text: 'Test agreement', issuer: 'Test', jurisdiction: 'Switzerland', signingEnabled: false },
    });
    if (path === '/api/reports/resolve-issue') return Response.json({ status: 'unmatched' });
    if (path === '/api/reports/palette-recent') return Response.json({ id: 'palette-recent', status: 'published' });
    throw new Error(`Unexpected report request ${method} ${path}`);
  });
  return calls;
}
async function waitFor(check: () => boolean) {
  for (let n = 0; n < 200 && !check(); n++) { await settleReportWork(); await advance(5); }
  assert.ok(check(), 'real lazy report dialog settled');
}
function row() { return destinationOption('panel:error-report'); }

test('#8947 absent host and missing eligible context explain refusal; disabled selection omits run footer', async t => {
  const calls = transport(t);
  host = mountDestinations(null);
  searchDestination('report error');
  assert.equal(row().getAttribute('aria-disabled'), 'true');
  assert.match(row().textContent ?? '', /Error reporting is not available in this viewer/);
  assert.equal(document.body.textContent?.includes('↵'), false);
  click(row()); await advance(30);
  assert.equal(document.querySelector('[role="dialog"]')?.textContent?.includes('Your chance'), false);
  cleanup(); await host.dispose();
  host = mountDestinations(<ErrorReportHost />);
  searchDestination('report error');
  assert.match(row().textContent ?? '', /No eligible error/);
  assert.deepEqual(calls, []);
});

test('#8947 live invitation opens actual dialog with exact failed source and correlation; cancel never uploads', async t => {
  const calls = transport(t);
  host = mountDestinations(<ErrorReportHost />);
  searchDestination('report error');
  assert.equal(row().getAttribute('aria-disabled'), 'true');
  const context = { errorCode: 'load_failed', sourceFile: new File(['exact bytes'], 'exact-failed-source.ifc'),
    correlation: { eventId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222', buildSha: 'failed-build' } };
  act(() => offerErrorReport(context, true));
  assert.notEqual(row().getAttribute('aria-disabled'), 'true');
  click(row()); await waitFor(() => !!document.querySelector('input[type="file"]'));
  assert.equal(getReportPrompt()?.context, context);
  assert.equal(document.querySelector<HTMLInputElement>('input[maxlength="180"]')?.value, 'Problem loading a model');
  assert.deepEqual(calls.map(c => c.method), ['GET'], 'activation only reads service configuration');
  const useSource = [...document.querySelectorAll('label')].find(label => label.textContent?.includes('Use the model from this failed load'))?.querySelector('input[type="checkbox"]');
  // The source option belongs to the real attachment UI, not a test double.
  const sourceCheckbox = useSource ?? document.querySelector('fieldset input[type="checkbox"]');
  assert.ok(sourceCheckbox); click(sourceCheckbox);
  assert.match(document.body.textContent ?? '', /exact-failed-source\.ifc/);
  click(namedButton('Check for an existing issue'));
  await waitFor(() => calls.some(c => c.path.endsWith('/resolve-issue')));
  assert.deepEqual(calls.find(c => c.path.endsWith('/resolve-issue'))?.body, context.correlation);
  click(namedButton('Cancel and delete draft')); await waitFor(() => getReportPrompt() === null);
  assert.deepEqual(calls.map(c => c.path), ['/api/reports/session', '/api/reports/resolve-issue']);
  act(() => offerErrorReport({ errorCode: 'load_failed', sourceFile: context.sourceFile }));
  assert.equal(getReportPrompt(), null, 'dismissed-context cooldown remains active');
});

test('#8947 recent reference reopens real receipt; current invitation wins and close preserves ownership', async t => {
  const calls = transport(t);
  rememberReport('palette-recent'); completeReport('palette-recent');
  host = mountDestinations(<ErrorReportHost />);
  const context = { errorCode: 'palette_current_invitation' };
  act(() => offerErrorReport(context, true));
  searchDestination('report error'); click(row());
  await waitFor(() => !!document.querySelector('input[type="file"]'));
  assert.equal(getReportPrompt()?.context, context);
  act(() => openErrorReportDestination('recent'));
  assert.equal(getReportPrompt()?.context, context, 'open report is never replaced');
  click(namedButton('Cancel and delete draft')); await waitFor(() => getReportPrompt() === null);
  searchDestination('report error'); click(row());
  await waitFor(() => document.body.textContent?.includes('palette-recent') ?? false);
  assert.equal(getReportPrompt()?.context.resumeReportId, 'palette-recent');
  click(namedButton('Close')); await waitFor(() => getReportPrompt() === null);
  click(namedButton('View recent report'));
  await waitFor(() => document.body.textContent?.includes('palette-recent') ?? false);
  assert.equal(getReportPrompt()?.context.resumeReportId, 'palette-recent', 'host button and palette reopen the same report');
  click(namedButton('Close')); await waitFor(() => getReportPrompt() === null);
  assert.ok(calls.every(c => c.method === 'GET'), 'no upload, submission or deletion');
});

test('#8947 host unmount disables live palette and stale destination activation cannot open a report', async t => {
  const calls = transport(t);
  host = mountDestinations(<ToggleHost />);
  act(() => offerErrorReport({ errorCode: 'palette_stale_host' }, true));
  searchDestination('report error'); const stale = row();
  assert.notEqual(stale.getAttribute('aria-disabled'), 'true');
  act(() => showHost(false));
  assert.equal(row().getAttribute('aria-disabled'), 'true');
  click(stale); act(() => openErrorReportDestination()); await advance(30);
  assert.equal(getReportPrompt()?.open, false);
  assert.deepEqual(calls, []);
});

test('#8947 pending reference opens through invitation button and lost eligibility refuses stale palette action', async t => {
  const calls = transport(t);
  rememberReport('palette-recent');
  host = mountDestinations(<ErrorReportHost />);
  assert.equal(getReportPrompt()?.context.resumeReportId, 'palette-recent');
  click(namedButton('Help improve IFC Lite'));
  await waitFor(() => document.body.textContent?.includes('palette-recent') ?? false);
  assert.equal(getReportPrompt()?.open, true);
  click(namedButton('Close')); await waitFor(() => getReportPrompt() === null);
  act(() => forgetReport('palette-recent'));
  act(() => offerErrorReport({ errorCode: 'palette_ephemeral' }, true));
  searchDestination('report error'); const stale = row();
  act(dismissErrorReport);
  assert.equal(row().getAttribute('aria-disabled'), 'true');
  assert.match(row().textContent ?? '', /No eligible error/);
  click(stale); act(() => openErrorReportDestination()); await advance(30);
  assert.equal(getReportPrompt(), null);
  assert.ok(calls.every(c => c.method === 'GET'));
});
