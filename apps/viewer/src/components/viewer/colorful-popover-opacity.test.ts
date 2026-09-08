/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #1924: dropdown popups were see-through in the secret "colorful" theme.
 *
 * The theme deliberately glasses panel surfaces — `.colorful .bg-white` is
 * rewritten to `--cf-glass` (48% alpha) with `!important`, and `--color-popover`
 * was `--cf-glass-strong` (68%). Panels sit against the aurora backdrop so that
 * reads well, but a dropdown floats over arbitrary content and at those alphas
 * the option text becomes unreadable.
 *
 * These assertions run against the stylesheet source rather than a rendered
 * DOM: the rules are plain CSS with no JS behaviour to exercise, and Tailwind's
 * utilities are not materialised in the test environment, so a jsdom/happy-dom
 * `getComputedStyle` check would pass whatever the file said. Reading the
 * source is the honest way to pin an `!important` ordering contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(__dirname, '../../index.css'), 'utf-8');

/**
 * Just the `.colorful { ... }` token block. `--color-popover` is also defined
 * for the light and dark themes, so an unscoped search matches the light one
 * first and the assertion silently tests nothing.
 */
const COLORFUL_BLOCK = (() => {
  const start = CSS.indexOf('.colorful {');
  assert.ok(start > 0, '.colorful token block must exist');
  const end = CSS.indexOf('\n}', start);
  assert.ok(end > start, '.colorful token block must terminate');
  return CSS.slice(start, end);
})();

/** Alpha of an `rgba(r, g, b, a)` literal; 1 for any opaque form. */
function alphaOf(color: string): number {
  const m = color.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
  return m ? Number(m[1]) : 1;
}

describe('colorful theme: dropdown popups stay opaque (#1924)', () => {
  it('--cf-popover-solid is fully opaque', () => {
    const m = COLORFUL_BLOCK.match(/--cf-popover-solid:\s*([^;]+);/);
    assert.ok(m, '--cf-popover-solid must be defined');
    assert.equal(alphaOf(m[1].trim()), 1, `popup surface must be opaque, got ${m[1].trim()}`);
  });

  it('--color-popover resolves to the solid token, not the glass one', () => {
    const m = COLORFUL_BLOCK.match(/--color-popover:\s*([^;]+?)\s*(?:!important)?;/);
    assert.ok(m, '--color-popover must be defined in .colorful');
    assert.match(
      m[1],
      /--cf-popover-solid/,
      'Radix Select/DropdownMenu render on `bg-popover`; pointing this at a glass token is exactly what made them see-through',
    );
  });

  it('the popover-surface rule comes AFTER the .bg-white glass rule', () => {
    // Both carry `!important` and equal specificity would not save us — the
    // later rule wins. If the glass block is ever moved below this one, the
    // hand-rolled popups silently go transparent again.
    const glass = CSS.indexOf('.colorful .bg-white');
    const popover = CSS.indexOf('.colorful .popover-surface');
    assert.ok(glass > 0, '.colorful .bg-white glass rule must exist');
    assert.ok(popover > 0, '.colorful .popover-surface rule must exist');
    assert.ok(
      popover > glass,
      'the opaque popup rule must come after the glass rule, or the glass wins the cascade',
    );
  });

  it('the popover-surface rule disables backdrop-filter', () => {
    const block = CSS.slice(CSS.indexOf('.colorful .popover-surface'));
    const body = block.slice(0, block.indexOf('}'));
    assert.match(
      body,
      /backdrop-filter:\s*none\s*!important/,
      'backdrop-filter creates a stacking context and containing block — the likely cause of the reported paint-order inversion',
    );
  });
});
