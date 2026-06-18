/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubEvent } from './analytics-scrub.js';

// `scrubEvent` is the single `before_send` gate every captured event passes
// through: it drops unactionable third-party noise, tags the geometry
// error family with a stable `error_kind`, and scrubs PII / confidential
// model identifiers. These tests pin that contract.

type CaptureEvent = { event?: string; properties?: Record<string, unknown> };

const exceptionEvent = (value: string, extraProps: Record<string, unknown> = {}): CaptureEvent => ({
  event: '$exception',
  properties: {
    $exception_list: [{ type: 'Error', value }],
    ...extraProps,
  },
});

describe('scrubEvent — error_kind tagging', () => {
  it('tags a raw wasm "unreachable" trap (autocaptured, issue #1196)', () => {
    const out = scrubEvent(exceptionEvent('unreachable'));
    assert.equal(out?.properties?.error_kind, 'geometry_worker_crash');
  });

  it('tags the main-thread RangeError OOM (issue #1215)', () => {
    const out = scrubEvent(exceptionEvent('Array buffer allocation failed'));
    assert.equal(out?.properties?.error_kind, 'out_of_memory');
  });

  it('tags the geometry stream watchdog timeout (issues #1194/#1204)', () => {
    const out = scrubEvent(exceptionEvent('Geometry stream stalled after 40000ms. Last rendered meshes: 0.'));
    assert.equal(out?.properties?.error_kind, 'geometry_stream_stalled');
  });

  it('reads the message from $exception_values when no $exception_list is present', () => {
    const out = scrubEvent({
      event: '$exception',
      properties: { $exception_values: ['Geometry worker failed: undefined'] },
    } as CaptureEvent);
    assert.equal(out?.properties?.error_kind, 'geometry_worker_crash');
  });

  it('does not clobber an error_kind set explicitly at the capture site', () => {
    const out = scrubEvent(exceptionEvent('unreachable', { error_kind: 'out_of_memory' }));
    assert.equal(out?.properties?.error_kind, 'out_of_memory');
  });

  it('leaves non-exception events untagged', () => {
    const out = scrubEvent({ event: 'ifc_model_loaded', properties: { file_size_mb: 12 } } as CaptureEvent);
    assert.equal(out?.properties?.error_kind, undefined);
  });
});

describe('scrubEvent — noise filter + PII guard (regression)', () => {
  it('drops the Cesium RequestErrorEvent noise (issue #1175)', () => {
    const out = scrubEvent({
      event: '$exception',
      properties: {
        $exception_list: [
          { type: 'Error', value: "'D_' captured as exception with keys: response, responseHeaders, statusCode" },
        ],
      },
    });
    assert.equal(out, null);
  });

  it('strips a confidential file name and path from event properties', () => {
    const out = scrubEvent({
      event: 'custom',
      // `file_name` is a sensitive key → deleted; `detail` is not sensitive but
      // its value is path-ish → redacted; `count` is plain → untouched.
      properties: { file_name: 'Confidential-Tower.ifc', detail: '/Users/me/Confidential-Tower.ifc', count: 3 },
    });
    assert.equal(out?.properties?.file_name, undefined);
    assert.equal(out?.properties?.detail, '[redacted]');
    assert.equal(out?.properties?.count, 3);
  });

  it('passes a null event through untouched', () => {
    assert.equal(scrubEvent(null), null);
  });
});
