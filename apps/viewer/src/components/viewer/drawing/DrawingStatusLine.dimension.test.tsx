/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { setLocale } from '@/i18n';
import { DrawingStatusLine, type DrawingStatusLineProps } from './DrawingStatusLine.js';

afterEach(cleanup);

const base: DrawingStatusLineProps = {
  activeTool: 'dimension', measureStarted: false, shiftLocked: false, snapped: false, polygonPointCount: 0, cloudPointCount: 0,
  textEditing: false, selection: null, counts: { measurements: 0, areas: 0, texts: 0, clouds: 0, dimensions: 0 }, underlayCount: 0, updating: false,
};

it('guides each step of the dimension tool and names the snap under the cursor', () => {
  setLocale('en');
  const text = (p: Partial<DrawingStatusLineProps>) => {
    cleanup();
    return render(<DrawingStatusLine {...base} {...p} />).textContent ?? '';
  };
  assert.ok(text({ dimensionStep: 0 }).includes('Click the first point to dimension'));
  assert.ok(text({ dimensionStep: 1, dimensionSnap: 'midpoint', snapped: false }).includes('Midpoint'));
  const placing = text({ dimensionStep: 2 });
  assert.ok(placing.includes('Shift = horizontal/vertical'), placing);
  assert.ok(text({ dimensionStep: 1, dimensionSnap: 'perpendicular' }).includes('Perpendicular'));
});

it('counts dimensions among the markup facts', () => {
  setLocale('en');
  const ui = render(<DrawingStatusLine {...base} activeTool="none" counts={{ ...base.counts, dimensions: 2 }} />);
  assert.ok((ui.textContent ?? '').includes('2 dimensions'), ui.textContent ?? '');
});
