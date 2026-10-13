/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostHog } from 'posthog-js/lib/src/posthog-core.js';
import { PostHogExceptions } from 'posthog-js/lib/src/posthog-exceptions.js';
import { beforeSend } from '../analytics.js';
import { loadFeature } from '../../../../report-service/test/feature-loader.js';
const feature = await loadFeature(new URL('./correlation.js', import.meta.url).pathname, () => import('./correlation.js'));

test('#7495 installed SDK captureException returns the exact scrubbed outbound identity', async () => {
  const sdk = new PostHog();
  const sent: unknown[] = [];
  let reviewed = 0;
  // Only replace the network boundary. Capture, error coercion, session UUID,
  // super-properties and IFC Lite's real privacy pipeline all execute normally.
  sdk._send_request = sdk._send_retriable_request = request => { sent.push(request.data); };
  sdk.init('qualification-test-only', {
    api_host: 'https://posthog.invalid', opt_out_useragent_filter: true, persistence: 'memory', autocapture: false,
    capture_pageview: false, capture_pageleave: false, disable_session_recording: true,
    advanced_disable_flags: true, disable_external_dependency_loading: true, request_batching: false,
    before_send: event => { reviewed++; return beforeSend(event); },
  });
  sdk.exceptions = new PostHogExceptions(sdk);
  sdk.register({ app_build_sha: 'qualified-build', app_version: 'qualification' });
  try {
    assert.equal(sdk.is_capturing(), true);
    const error = new Error('Unable to load /private/client.ifc');
    error.stack = 'Error: Unable to load /private/client.ifc\n    at loadFile (https://ifclite.com/assets/index.js:1:2)';
    const event = sdk.captureException(error);
    assert.ok(event, `capture must return an event (privacy pipeline calls: ${reviewed})`);
    const correlation = feature?.reportCorrelation(event);
    assert.ok(correlation);
    assert.equal(correlation.eventId, event.uuid);
    assert.equal(correlation.sessionId, sdk.get_session_id());
    assert.equal(correlation.buildSha, 'qualified-build');
    assert.ok(sent.some(item => typeof item === 'object' && item !== null && 'uuid' in item && item.uuid === event.uuid));
    assert.equal(JSON.stringify(event).includes('/private/client.ifc'), false);
    sdk.opt_out_capturing();
    assert.equal(feature?.reportCorrelation(sdk.captureException(new Error('Opted out'))), undefined);
  } finally { await sdk.shutdown(); sdk.sessionManager?.destroy(); }
});
