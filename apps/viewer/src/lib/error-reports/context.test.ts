/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { showLoadError } from '../analytics';
import { clearLoadReport, dismissErrorReport, getReportPrompt, offerErrorReport, openErrorReport } from './context';
afterEach(dismissErrorReport);

test('#7495 failed federated load retains its own File even without a registered model', () => {
  const failed = new File(['failed federation'], 'federation.ifc');
  let visibleError = '';
  showLoadError(message => { visibleError = message; }, () => {}, 'Cannot load model', 'geometry_processing', null, failed);
  assert.equal(visibleError, 'Cannot load model');
  assert.equal(getReportPrompt()?.context.sourceFile, failed);
  offerErrorReport({ errorCode: 'unhandled_viewer_error' });
  assert.equal(getReportPrompt()?.context.sourceFile, failed, 'generic follow-up failure cannot substitute the source');
  openErrorReport();
  clearLoadReport();
  assert.equal(getReportPrompt()?.context.sourceFile, failed, 'active review retains the reviewed source');
  dismissErrorReport();
  assert.equal(getReportPrompt(), null, 'dismiss releases the source');
});

test('#7495 clearing an unreviewed load failure releases its File', () => {
  offerErrorReport({ errorCode: 'load_failed', sourceFile: new File(['source'], 'source.ifc') });
  clearLoadReport(); assert.equal(getReportPrompt(), null);
});

test('#7495 Not now suppresses repeated invitations without suppressing other errors or explicit resume', () => {
  offerErrorReport({ errorCode: 'repeating_global_error' });
  dismissErrorReport();
  offerErrorReport({ errorCode: 'repeating_global_error', sourceFile: new File(['large'], 'discarded.ifc') });
  assert.equal(getReportPrompt(), null);
  offerErrorReport({ errorCode: 'different_error' });
  assert.equal(getReportPrompt()?.context.errorCode, 'different_error');
  dismissErrorReport();
  offerErrorReport({ errorCode: 'repeating_global_error', resumeReportId: 'owned-report' });
  assert.equal(getReportPrompt()?.context.resumeReportId, 'owned-report');
  dismissErrorReport();
  offerErrorReport({ errorCode: 'repeating_global_error' }, true);
  assert.equal(getReportPrompt()?.context.errorCode, 'repeating_global_error');
});
