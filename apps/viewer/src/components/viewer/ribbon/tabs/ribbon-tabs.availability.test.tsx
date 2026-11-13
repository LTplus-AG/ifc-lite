/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10147: each ribbon tab decides at render time which of its groups a host
 * left anything in (`lib/features`). With every switchable feature off, no
 * tab may show a group with no control in it, or a divider that does not sit
 * between two groups.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentType } from 'react';
import { cleanup, render } from '@/test/render.js';
import { resetFeaturesForTest } from '@/lib/features';
import { AnalyzeTab } from './AnalyzeTab';
import { AuthorTab } from './AuthorTab';
import { ElementsTab } from './ElementsTab';
import { HomeTab } from './HomeTab';
import { ViewTab } from './ViewTab';

afterEach(() => {
  cleanup();
  resetFeaturesForTest();
});

const CONTROL = 'button, input, select, a[href]';
const GROUP_OR_DIVIDER = '[role="group"], div[aria-hidden="true"].bg-divider';

/** The band's groups and dividers in document order, as `G` (group) and `|` (divider); an empty group is `_`. */
function bandShape(root: Element): string {
  return [...root.querySelectorAll(GROUP_OR_DIVIDER)]
    .map((node) => (node.getAttribute('role') === 'group' ? (node.querySelector(CONTROL) ? 'G' : '_') : '|'))
    .join('');
}

const TABS: ReadonlyArray<[string, ComponentType]> = [
  ['Home', HomeTab],
  ['View', ViewTab],
  ['Elements', ElementsTab],
  ['Author', AuthorTab],
  ['Analyze', AnalyzeTab],
];

for (const [name, Tab] of TABS) {
  it(`${name} tab shows no empty group and no stray divider with every feature off`, () => {
    resetFeaturesForTest({ default: 'none' });
    const shape = bandShape(render(<Tab />));
    assert.match(shape, /^G(\|G)*$/, `${name} band: ${shape}`);
  });
}
