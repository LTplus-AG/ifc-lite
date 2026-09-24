/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';
import { reportFileOpenRejected } from './fileOpenRejected';

let captured: unknown[][] = [];
let toasts: unknown[] = [];

beforeEach(() => {
  captured = [];
  toasts = [];
  mock.method(posthog, 'capture', (...args: unknown[]) => { captured.push(args); });
  mock.method(toast, 'error', (message: unknown) => { toasts.push(message); });
});
afterEach(() => mock.restoreAll());

describe('file_open_rejected (#5618)', () => {
  it('reports the reason category only, and tells the user why for a format we recognise', () => {
    reportFileOpenRejected([new File([''], 'Client Tower.blend')]);
    reportFileOpenRejected([new File([''], 'notes.xyz')]);
    assert.equal(toasts.length, 1);
    assert.match(String(toasts[0]), /^Client Tower\.blend: Blender scene/);
    assert.deepEqual(captured, [
      ['file_open_rejected', { reason: 'unsupported_format' }],
      ['file_open_rejected', { reason: 'unrecognized_format' }],
    ]);
  });

  it('does not count a DXF-only pick, which loads as an underlay', () => {
    reportFileOpenRejected([new File([''], 'site.dxf')]);
    assert.deepEqual(captured, []);
    assert.deepEqual(toasts, []);
  });
});
