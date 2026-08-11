/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ClashPanel renders a duplicate scan as coincident-set sections (#2530
 * review blocker).
 *
 * The blocker's exact symptom: `groupDuplicateSets` was stored in
 * `clashGroups`, which no component read, so three coincident columns still
 * rendered as three sibling pair rows under a generic severity header. The
 * section-builder maths is unit-tested in `duplicate-set-sections.test.ts`;
 * this renders the REAL panel over a seeded store and pins the glue — the
 * panel actually consumes `clashGroups` — which is precisely the line whose
 * absence shipped the dead state.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { findDuplicates, groupDuplicateSets, type ClashElement } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { ClashPanel } from './ClashPanel.js';

let nextRef = 1;

function element(key: string): ClashElement {
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag: 'IfcColumn',
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    positions: new Float32Array(0),
    indices: new Uint32Array(6),
  };
}

// happy-dom performs no layout, so every element measures 0×0 and the panel's
// row virtualizer (which reads `offsetWidth`/`offsetHeight`, see
// @tanstack/virtual-core `getRect`) computes an empty window — no section
// header would render no matter what the panel does. Give every element a
// fixed size so the virtual list actually materializes rows. Scoped to this
// test file's process (node:test runs each file in its own child process).
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

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
});

describe('ClashPanel — duplicate scan sections (#2530)', () => {
  it('shows ONE coincident-set header for a triplicated column, not a generic bucket', async () => {
    const result = findDuplicates([element('a'), element('b'), element('c')]);
    assert.equal(result.clashes.length, 3, 'fixture: 3 pairwise rows');
    useViewerStore.setState({
      clashResult: result,
      clashGroups: groupDuplicateSets(result),
    });
    await renderPanel();
    const text = container!.textContent ?? '';
    assert.ok(
      text.includes('3 coincident IfcColumn objects'),
      `panel must render the set title; got: ${text.slice(0, 400)}`,
    );
    // And it is the section header, not an extra row alongside the generic
    // severity bucket the pre-#2530 panel showed.
    assert.ok(!text.includes('Minor ('), 'generic severity header must be replaced');
  });
});
