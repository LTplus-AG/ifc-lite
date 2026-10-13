/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CapturedNetworkRequest } from 'posthog-js';
// Exercise the installed SDK's real configuration selection, including its
// initial-performance fallback. SDK upgrades must preserve this privacy boundary.
import { buildNetworkRequestOptions } from 'posthog-js/lib/src/extensions/replay/external/config.js';
import { defaultConfig } from 'posthog-js/lib/src/posthog-core.js';
import { maskReportNetworkRequest, reportReplayPrivacy } from './analytics-report-privacy.js';

function request(name: string, isInitial = false): CapturedNetworkRequest {
  return { name, entryType: 'resource', startTime: 1, duration: 2, isInitial,
    requestBody: 'private IFC filename and NDA signer', responseBody: 'presigned upload credential',
    requestHeaders: { cookie: 'owner-session', 'x-csrf-token': 'csrf-secret' },
    responseHeaders: { 'set-cookie': 'owner-session' } };
}
const urls = [
  '/api/reports/drafts', 'https://ifclite.com/api/reports/id/consent',
  'https://reports.example/api/reports/id/agreement.pdf', '/api/%72eports/session',
  'https://bucket.s3.fr-par.scw.cloud/private/12345678-1234-1234-1234-123456789abc/abcdefab-1234-1234-1234-123456789abc',
  'https://custom-storage.example/bucket/object?X-Amz-Signature=secret',
  'https://custom-storage.example/object?x-amz-credential=secret',
  'https://custom-storage.example/object?AWSAccessKeyId=secret&Signature=secret',
  'http://[invalid', '/api/%zz',
];

describe('report session replay network privacy (#7495)', () => {
  it('drops report API, private object keys and presigned URLs without retaining their content', () => {
    for (const url of urls) assert.equal(maskReportNetworkRequest(request(url)), undefined, url);
  });
  it('preserves unrelated network timing without weakening SDK body/header privacy', () => {
    const input = request('https://ifclite.com/assets/viewer.js?v=build');
    assert.deepEqual(maskReportNetworkRequest(input), {
      name: input.name, entryType: 'resource', startTime: 1, duration: 2, isInitial: false,
    });
    assert.equal(input.requestHeaders?.cookie, 'owner-session', 'does not mutate SDK input');
  });
  it('real SDK rejects remote body/header enablement and suppresses sensitive replay entries', () => {
    const options = buildNetworkRequestOptions({ ...defaultConfig(), api_host: 'https://eu.i.posthog.com',
      session_recording: reportReplayPrivacy },
    { recordBody: true, recordHeaders: true, recordPerformance: true });
    assert.equal(options.recordBody, false);
    assert.equal(options.recordHeaders, false);
    assert.equal(options.recordPerformance, true);
    assert.ok(options.maskRequestFn);
    for (const url of urls) {
      assert.equal(options.maskRequestFn(request(url)), undefined);
      const initial = options.maskRequestFn(request(url, true));
      assert.equal(initial?.name, '');
      assert.equal(initial?.duration, 2);
      assert.equal(initial?.requestBody, undefined);
      assert.equal(initial?.responseBody, undefined);
      assert.equal(initial?.requestHeaders, undefined);
      assert.equal(initial?.responseHeaders, undefined);
    }
    const ordinary = options.maskRequestFn(request('https://ifclite.com/assets/worker.js'));
    assert.equal(ordinary?.name, 'https://ifclite.com/assets/worker.js');
    assert.equal(ordinary?.duration, 2);
  });
});
