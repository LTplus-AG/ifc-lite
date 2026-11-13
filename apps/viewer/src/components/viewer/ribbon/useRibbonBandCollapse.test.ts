/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collapseEmptyRibbonGroups } from './useRibbonBandCollapse';

/**
 * A band from a compact spec: `G` a group with a button, `g` a group left
 * empty, `|` a divider, `(...)` a wrapper element like the Analyze tab's.
 */
function band(spec: string): HTMLElement {
  const root = document.createElement('div');
  let parent: HTMLElement = root;
  for (const char of spec.replaceAll(' ', '')) {
    if (char === '(') { const wrapper = document.createElement('div'); parent.append(wrapper); parent = wrapper; continue; }
    if (char === ')') { parent = root; continue; }
    const node = document.createElement('div');
    if (char === '|') node.setAttribute('data-ribbon-divider', '');
    else {
      node.setAttribute('data-ribbon-group', '');
      if (char === 'G') node.append(document.createElement('button'));
    }
    parent.append(node);
  }
  document.body.append(root);
  return root;
}

/** What shows, in the same notation, wrappers dropped. */
function shown(root: HTMLElement): string {
  return [...root.querySelectorAll<HTMLElement>('[data-ribbon-group], [data-ribbon-divider]')]
    .filter((node) => node.style.display !== 'none')
    .map((node) => (node.hasAttribute('data-ribbon-divider') ? '|' : 'G'))
    .join('');
}

afterEach(() => document.body.replaceChildren());

describe('the ribbon band after a host switched features off', () => {
  const cases: Array<[string, string, string]> = [
    ['leaves a full band alone', 'G|G|G', 'G|G|G'],
    ['drops an empty group and one of its two dividers', 'G|g|G', 'G|G'],
    ['drops a leading empty group and its divider', 'g|G|G', 'G|G'],
    ['drops a trailing empty group and its divider', 'G|G|g', 'G|G'],
    ['drops a trailing divider whose group rendered nothing at all', 'G||G', 'G|G'],
    ['drops a divider with nothing after it', 'G|', 'G'],
    ['keeps one divider across a run of empty groups', 'G|g|g|G', 'G|G'],
    ['sees through wrappers, as the Analyze tab nests its groups', 'G(|g)(|G)(|g)(|G)', 'G|G|G'],
    ['shows nothing when every group is empty', 'g|g', ''],
  ];
  for (const [what, spec, expected] of cases) {
    it(what, () => {
      const root = band(spec);
      collapseEmptyRibbonGroups(root);
      assert.equal(shown(root), expected);
    });
  }

  it('brings a group back when its control appears', () => {
    const root = band('G|g|G');
    collapseEmptyRibbonGroups(root);
    root.querySelectorAll('[data-ribbon-group]')[1].append(document.createElement('button'));
    collapseEmptyRibbonGroups(root);
    assert.equal(shown(root), 'G|G|G');
  });
});
