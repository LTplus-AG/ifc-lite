/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5395: a large ribbon button must size to its label, never to a fixed width.
 *
 * A fixed `w-14` (56 px) clipped any single word wider than the ~48 px label
 * box sideways, with no ellipsis ("Orthographic" -> "Orthograpl"). Since the
 * compact band (#8802 R1) the label is one unwrapped line, so the button's
 * width is the label's own width, with a 48 px floor. happy-dom has no
 * layout engine, so this in-process test pins the sizing RULE on the
 * rendered button. The layout itself (every tab, every label, real text
 * metrics) is measured in a real browser by
 * `tests/e2e/ribbon-labels.e2e.spec.ts`.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Box } from 'lucide-react';
import { cleanup, render } from '@/test/render.js';
import { RibbonContentLargeButton, type RibbonContentButtonProps } from './primitives.js';

// @ts-expect-error #5878: the content primitive cannot take a free-form command label.
const rawCommandLabel: RibbonContentButtonProps = { icon: Box, label: 'Foo', contentSource: 'export', contentId: 'fake' };
void rawCommandLabel;

afterEach(cleanup);

describe('RibbonContentLargeButton sizing (#5395)', () => {
  it('sizes to its one-line label with a 48 px floor instead of a fixed width', () => {
    const container = render(<RibbonContentLargeButton icon={Box} contentLabel="Orthographic" contentSource="export" contentId="test" />);
    const button = container.querySelector('button');
    assert.ok(button, 'the button rendered');
    const classes = button.className.split(/\s+/);
    // A fixed Tailwind width (`w-14`, `w-16`, `w-[60px]`) is what clipped.
    const fixed = classes.filter((c) => /^w-(\d+|\[.+\])$/.test(c));
    assert.deepEqual(fixed, [], 'no fixed width: a long single word must be able to widen the button');
    assert.ok(classes.includes('min-w-12'), 'a 48 px floor keeps short labels on an even rhythm');
    const label = container.querySelector('[data-ribbon-label]');
    assert.ok(label?.classList.contains('whitespace-nowrap'), 'one line: the label never wraps or clamps');
    // The full label is in the DOM (nothing truncated in the markup either).
    assert.equal(container.querySelector('[data-ribbon-label]')?.textContent, 'Orthographic');
  });
});
