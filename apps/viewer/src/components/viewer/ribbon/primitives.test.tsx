/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5395: a large ribbon button must size to its label, never to a fixed width.
 *
 * A fixed `w-14` (56 px) clipped any single word wider than the ~48 px label
 * box sideways, with no ellipsis ("Orthographic" -> "Orthograpl"). happy-dom has
 * no layout engine, so this in-process test pins the sizing RULE on the
 * rendered button: min-content width with a 56 px floor. The layout itself
 * (every tab, every label, real text metrics) is measured in a real browser by
 * `tests/e2e/ribbon-labels.e2e.spec.ts`.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Box } from 'lucide-react';
import { cleanup, render } from '@/test/render.js';
import { RibbonLargeButton } from './primitives.js';

afterEach(cleanup);

describe('RibbonLargeButton sizing (#5395)', () => {
  it('sizes to its longest word with a 56 px floor instead of a fixed width', () => {
    const container = render(<RibbonLargeButton icon={Box} label="Orthographic" />);
    const button = container.querySelector('button');
    assert.ok(button, 'the button rendered');
    const classes = button.className.split(/\s+/);
    // A fixed Tailwind width (`w-14`, `w-16`, `w-[60px]`) is what clipped.
    const fixed = classes.filter((c) => /^w-(\d+|\[.+\])$/.test(c));
    assert.deepEqual(fixed, [], 'no fixed width: a long single word must be able to widen the button');
    assert.ok(classes.includes('w-min'), 'min-content width: the longest unbreakable word sets the width');
    assert.ok(classes.includes('min-w-14'), 'the old 56 px stays as a floor so short labels look the same');
    // The full label is in the DOM (nothing truncated in the markup either).
    assert.equal(container.querySelector('[data-ribbon-label]')?.textContent, 'Orthographic');
  });
});
