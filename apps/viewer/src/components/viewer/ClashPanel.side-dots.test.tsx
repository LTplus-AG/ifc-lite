/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The panel's side A / B dots use the same colours the 3D view tints the
 * focused pair with (#5490). They were a hard-coded cyan / violet pair
 * (`#7dcfff`, `#bb9af7`) while the 3D pair was amber / cyan, so side A's dot
 * matched side B's element on screen. Now both read the `clash-a` / `clash-b`
 * tokens: the dots through the Tailwind utilities `index.css` maps onto
 * `--overlay-clash-a` / `-b`, the 3D tint through `setClashColorsFromTheme`.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeClashes, type Clash, type ClashResult } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { render, click, cleanup } from '@/test/render.js';
import { ClashPanel } from './ClashPanel.js';

const CLASH: Clash = {
  id: 'clash-1',
  a: { key: 'a', ref: 11, model: 'model.ifc', tag: 'IfcPipeSegment', name: 'Pipe' },
  b: { key: 'b', ref: 22, model: 'model.ifc', tag: 'IfcBeam', name: 'Beam' },
  rule: 'all-clashes',
  status: 'hard',
  distance: -0.05,
  point: [1, 2, 3],
  bounds: { min: [0.5, 1.5, 2.5], max: [1.5, 2.5, 3.5] },
  severity: 'major',
};

const RESULT: ClashResult = {
  clashes: [CLASH],
  summary: summarizeClashes([CLASH]),
  rulesRun: [{ id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' }],
  settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
};

afterEach(() => {
  cleanup();
  useViewerStore.setState({ clashResult: null, clashGroups: null });
});

describe('ClashPanel side dots (#5490)', () => {
  it('paints side A and side B with the clash-a / clash-b tokens the 3D pair uses', () => {
    useViewerStore.setState({
      clashResult: RESULT,
      clashGroups: null,
      clashStatusFilter: new Set(['open', 'resolved', 'accepted']),
      clashHideTouching: false,
    });
    const container = render(<ClashPanel />);
    const expand = container.querySelector('button[title="Show both objects"]');
    assert.ok(expand, 'the clash row offers an expand toggle');
    click(expand);

    const dotA = container.querySelector<HTMLElement>('[data-clash-side="a"]');
    const dotB = container.querySelector<HTMLElement>('[data-clash-side="b"]');
    assert.ok(dotA && dotB, 'the expanded row shows both sides');
    assert.ok(dotA.classList.contains('bg-clash-a'), 'side A dot uses the clash-a token');
    assert.ok(dotB.classList.contains('bg-clash-b'), 'side B dot uses the clash-b token');
    assert.equal(dotA.style.background, '', 'no hard-coded colour overrides the token');
    assert.equal(dotB.style.background, '', 'no hard-coded colour overrides the token');
    // The dot sits in the element's own row: side A labels the Pipe.
    assert.match(dotA.parentElement?.textContent ?? '', /IfcPipeSegment/);
  });
});
