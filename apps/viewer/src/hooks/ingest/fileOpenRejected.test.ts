/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { posthog } from '@/lib/analytics';
import { reportFileOpenRejected } from './fileOpenRejected';

let captured: unknown[][] = [];

beforeEach(() => {
  captured = [];
  mock.method(posthog, 'capture', (...args: unknown[]) => { captured.push(args); });
});
afterEach(() => mock.restoreAll());

describe('file_open_rejected (#5618)', () => {
  it('reports the reason category only, and explains a format we recognise', () => {
    assert.match(reportFileOpenRejected([new File([''], 'Client Tower.blend')]) ?? '', /^Client Tower\.blend: Blender scene/);
    assert.equal(reportFileOpenRejected([new File([''], 'notes.xyz')]), null);
    assert.deepEqual(captured, [
      ['file_open_rejected', { reason: 'unsupported_format' }],
      ['file_open_rejected', { reason: 'unrecognized_format' }],
    ]);
  });

  it('does not count a DXF-only pick, which loads as an underlay', () => {
    assert.equal(reportFileOpenRejected([new File([''], 'site.dxf')]), null);
    assert.deepEqual(captured, []);
  });
});
