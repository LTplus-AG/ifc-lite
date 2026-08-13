/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The panel's generic (non-duplicate) sections memo must recompute when the
 * FILTERED, SORTED clash list changes — not only when `result`, `groupBy` or
 * the duplicate-set grouping change.
 *
 * Bot finding on #2530 (CodeRabbit-style, verified independently here): while
 * splitting `duplicateSetSections` into its own memo (the "Group by does
 * nothing during a coincident-set view" fix), the generic-bucket branch of
 * `sections` kept reading `visibleClashes` in its body but the dependency
 * array was narrowed to `[result, setSections, groupBy]` — dropping
 * `visibleClashes`. For a NON-duplicate result, `setSections` is `null`
 * before AND after a filter/sort change (`null === null`), so the memo would
 * not recompute and the panel would keep showing the pre-filter rows.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Clash, ClashResult } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { ClashPanel } from './ClashPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

function clash(id: string, tag: string, distance: number): Clash {
  return {
    id,
    a: { key: `${id}-a`, ref: 1, model: 'm', tag },
    b: { key: `${id}-b`, ref: 2, model: 'm', tag: 'IfcColumn' },
    rule: 'hard-clash',
    status: 'hard',
    distance,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'major',
  };
}

function nonDuplicateResult(): ClashResult {
  // One touching contact (depth <= TOUCHING_EPSILON = 1e-4) and one genuine
  // hard clash — `hideTouching` must be able to tell them apart.
  const clashes = [clash('touch-1', 'IfcWall', -1e-6), clash('deep-1', 'IfcBeam', -0.5)];
  return {
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
  // Reset every store field this suite writes, not just the toggle: apps/viewer
  // runs all node:test files in ONE process against a shared Zustand store, so a
  // synthetic clashResult left behind here is inherited by every later mount.
  useViewerStore.setState({
    clashResult: null,
    clashGroups: null,
    clashHideTouching: false,
  });
});

describe('ClashPanel — generic sections recompute on filter/sort (#2530 bot finding)', () => {
  it('drops the touching row from the rendered panel once "hide touching" is toggled', async () => {
    useViewerStore.setState({
      clashResult: nonDuplicateResult(),
      clashGroups: [],
      clashHideTouching: false,
    });
    await renderPanel();

    const before = container!.textContent ?? '';
    assert.ok(
      before.includes('IfcWall × IfcColumn'),
      `expected the touching row before filtering; got: ${before.slice(0, 400)}`,
    );
    assert.ok(
      before.includes('IfcBeam × IfcColumn'),
      `expected the deep row before filtering; got: ${before.slice(0, 400)}`,
    );

    await act(async () => {
      useViewerStore.setState({ clashHideTouching: true });
    });

    const after = container!.textContent ?? '';
    assert.ok(
      !after.includes('IfcWall × IfcColumn'),
      `the touching row must disappear once "hide touching" is on; got: ${after.slice(0, 400)}`,
    );
    assert.ok(after.includes('IfcBeam × IfcColumn'), `the deep row must remain; got: ${after.slice(0, 400)}`);
  });
});
