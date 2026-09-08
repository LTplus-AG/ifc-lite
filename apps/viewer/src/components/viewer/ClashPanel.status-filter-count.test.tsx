/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The panel's header count must reconcile with the rendered list under a
 * REVIEW-STATUS filter, the same way it already does under "hide touching"
 * (`shown` is appended to the header only for that one filter — see the
 * `hideTouching && touchingCount > 0` guard in `ClashPanel.tsx`). The
 * `statusFilter` chips (open/resolved/accepted) can shrink `visibleClashes`
 * exactly the same way, but the header's big number and its trailing label
 * both read `result.summary.total` unconditionally, so a user who unticks
 * "resolved" sees a headline count (and a severity breakdown that sums to
 * it) that no longer matches the rows actually rendered below — the "clash
 * count of 88 vs 81" class of bug the project has hit before in a PR
 * description.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Clash, ClashResult } from '@ifc-lite/clash';
import { clashReviewKey } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { ClashPanel } from './ClashPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

function clash(id: string, tagA: string): Clash {
  return {
    id,
    a: { key: `${id}-a`, ref: 1, model: 'm', tag: tagA },
    b: { key: `${id}-b`, ref: 2, model: 'm', tag: 'IfcColumn' },
    rule: 'hard-clash',
    status: 'hard',
    distance: -0.05,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'major',
  };
}

function twoClashResult(): { result: ClashResult; open: Clash; resolved: Clash } {
  const open = clash('open-1', 'IfcWall');
  const resolved = clash('resolved-1', 'IfcBeam');
  const clashes = [open, resolved];
  const result: ClashResult = {
    clashes,
    summary: {
      total: clashes.length,
      byRule: { 'hard-clash': clashes.length },
      byTypePair: {},
      bySeverity: { critical: 0, major: clashes.length, minor: 0, info: 0 },
    },
    rulesRun: [{ id: 'hard-clash', name: 'Hard clash', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
  return { result, open, resolved };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function renderPanel(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ClashPanel />);
  });
}

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  useViewerStore.setState({
    clashResult: null,
    clashGroups: null,
    clashHideTouching: false,
    clashReviews: new Map(),
    clashStatusFilter: new Set(['open', 'resolved', 'accepted']),
  });
});

describe('ClashPanel — header count vs status-filtered list', () => {
  it('annotates the header with the filtered count once a review-status filter hides a row', async () => {
    const { result, resolved } = twoClashResult();
    const reviews = new Map([[clashReviewKey(resolved), { status: 'resolved' as const }]]);
    useViewerStore.setState({
      clashResult: result,
      clashGroups: [],
      clashHideTouching: false,
      clashReviews: reviews,
    });
    await renderPanel();

    // Untick "resolved" in the status filter: only the open clash remains visible.
    await act(async () => {
      useViewerStore.getState().toggleClashStatusFilter('resolved');
    });

    const text = container!.textContent ?? '';
    assert.ok(
      !text.includes('IfcBeam × IfcColumn'),
      `the resolved row must be filtered out of the list; got: ${text.slice(0, 500)}`,
    );
    assert.ok(
      text.includes('IfcWall × IfcColumn'),
      `the open row must remain; got: ${text.slice(0, 500)}`,
    );
    // The header must say only 1 is actually shown, not silently keep advertising
    // the unfiltered total of 2 with no indication that a row is hidden.
    assert.ok(
      text.includes('1 shown'),
      `header must reconcile with the filtered list (expected "1 shown"); got: ${text.slice(0, 500)}`,
    );
  });
});
