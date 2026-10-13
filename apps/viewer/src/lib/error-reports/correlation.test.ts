/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFeature } from '../../../../report-service/test/feature-loader.js';
const feature = await loadFeature(new URL('./correlation.js', import.meta.url).pathname, () => import('./correlation.js'));
import { dismissErrorReport, getReportPrompt, offerErrorReport, openErrorReport } from './context';
afterEach(dismissErrorReport);
const capture = () => ({ uuid: crypto.randomUUID(), properties: { $session_id: crypto.randomUUID(), app_build_sha: 'build-a' } });
test('#7495 exact captured federation error cannot bind another source or replace an open review', () => {
  const a = new File(['a'], 'same-name.ifc'); const b = new File(['b'], 'same-name.ifc');
  const event = capture();
  offerErrorReport({ errorCode: 'correlation-fixture', sourceFile: a }, true);
  feature?.attachCapturedLoad(b, event); assert.equal(getReportPrompt()?.context.correlation, undefined);
  feature?.attachCapturedLoad(a, event); assert.deepEqual(getReportPrompt()?.context.correlation, { eventId: event.uuid, sessionId: event.properties.$session_id, buildSha: 'build-a' });
  openErrorReport(); feature?.attachCapturedLoad(a, capture());
  assert.equal(getReportPrompt()?.context.correlation?.eventId, event.uuid);
});
test('#7495 opted-out or uncaptured errors have no invented telemetry identity', () => {
  assert.equal(feature?.reportCorrelation(undefined), undefined);
  assert.equal(feature?.reportCorrelation({ uuid: crypto.randomUUID(), properties: {} }), undefined);
});
