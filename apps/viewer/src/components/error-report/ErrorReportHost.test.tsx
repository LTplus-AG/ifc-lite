/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render, click } from '@/test/render.js';
import { clearLoadReport, dismissErrorReport, getReportPrompt, offerErrorReport } from '@/lib/error-reports/context';
import { forgetReport, rememberReport } from '@/lib/error-reports/pending';
import { ErrorReportHost } from './ErrorReportHost';
afterEach(() => { cleanup(); dismissErrorReport(); forgetReport('managed-report'); forgetReport('older-report'); });

test('#7495 closing a published report leaves a management entry until its private data is deleted', () => {
  rememberReport('managed-report');
  rememberReport(undefined);
  dismissErrorReport();
  const ui = render(<ErrorReportHost />);
  assert.ok([...ui.querySelectorAll('button')].some(button => button.textContent === 'View recent report'));
  assert.equal(ui.textContent?.includes('managed-report'), false, 'no identifier or model detail appears in the entry');
  act(() => forgetReport('managed-report'));
  assert.equal(ui.querySelector('button'), null);
});

// Deleting an older report must leave the newer report's management entry usable.
test('#7495 deleting an older report keeps the newer report available in the UI', () => {
  rememberReport('older-report');
  rememberReport('managed-report');
  const ui = render(<ErrorReportHost />);
  act(() => forgetReport('older-report'));
  const manage = [...ui.querySelectorAll('button')].find(button => button.textContent === 'View recent report');
  assert.ok(manage, 'newer report remains manageable');
  click(manage);
  assert.equal(getReportPrompt()?.context.resumeReportId, 'managed-report', 'management action opens the newer report');
  assert.equal(getReportPrompt()?.open, true);
});

for (const context of [
  { errorCode: 'gpu_device_lost' },
  { errorCode: 'report_resume', resumeReportId: 'managed-report' },
]) test(`#7500 starting a model load preserves the ${context.errorCode} invitation`, () => {
  const ui = render(<ErrorReportHost />);
  act(() => offerErrorReport(context, true));
  assert.ok(ui.textContent?.includes('Your chance to help IFC Lite'));
  act(clearLoadReport);
  assert.ok(ui.textContent?.includes('Your chance to help IFC Lite'));
  assert.ok([...ui.querySelectorAll('button')].some(button => button.textContent === 'Help improve IFC Lite'));
});
