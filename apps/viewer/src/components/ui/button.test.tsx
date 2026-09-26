/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `buttonVariants` (#5826): target size (WCAG 2.2 2.5.8) and focus
 * visibility (2.4.7) are properties of the generated class STRING, not of
 * anything a browser renders, so this asserts the classes directly rather
 * than a computed layout — no browser needed, so a regression here fails
 * fast, before the Playwright check in tests/e2e even needs a build.
 *
 * The icon sizes (36/32/28 px) carry NO hit-slop pseudo-element: they are
 * already at or above the 24px minimum on their own `h-*`/`w-*` classes, and
 * a uniform pseudo-element on every icon button was tried and reverted — it
 * overlapped adjacent toolbar buttons spaced by `gap-1`, a click-stealing
 * regression measured via `elementFromPoint` at the midpoint between two
 * neighbouring buttons. A caller that shrinks the visual box below 24px via
 * a `className` override (a real, shipped pattern —
 * `size="icon-sm" className="h-5 w-5"`) needs its OWN hit-slop at its own
 * call site (see MeasurementList.tsx's `DELETE` constant), not one here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buttonVariants } from './button.js';

const ICON_SIZES = ['icon', 'icon-sm', 'icon-xs'] as const;
const ALL_VARIANTS = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const;
/** Each icon size's own `h-*`/`w-*` pixel value — all >=24px unaided. */
const ICON_SIZE_PX: Record<(typeof ICON_SIZES)[number], number> = {
  icon: 36,
  'icon-sm': 32,
  'icon-xs': 28,
};

function parseTailwindLengthClass(classes: string, prefix: 'h' | 'w'): number | null {
  const match = classes.match(new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?:\\s|$)`));
  if (!match) return null;
  // Tailwind's default spacing scale: N -> N * 0.25rem -> N * 4px.
  return parseFloat(match[1]) * 4;
}

describe('buttonVariants', () => {
  it('keeps the focus-visible ring token on every variant, regardless of size', () => {
    for (const variant of ALL_VARIANTS) {
      for (const size of [...ICON_SIZES, 'default', 'sm', 'lg'] as const) {
        const classes = buttonVariants({ variant, size });
        assert.match(
          classes,
          /focus-visible:ring-1/,
          `variant=${variant} size=${size} lost the focus ring width`,
        );
        assert.match(
          classes,
          /focus-visible:ring-ring/,
          `variant=${variant} size=${size} lost the focus ring color token`,
        );
        assert.match(
          classes,
          /focus-visible:outline-none/,
          `variant=${variant} size=${size} lost the outline-none that lets the ring show instead of the native outline`,
        );
      }
    }
  });

  it('gives every icon size a >=24px CSS px box on its own h-*/w-* classes', () => {
    for (const size of ICON_SIZES) {
      const classes = buttonVariants({ size });
      const height = parseTailwindLengthClass(classes, 'h');
      const width = parseTailwindLengthClass(classes, 'w');
      assert.ok(height !== null, `size=${size} must declare an explicit h-* class`);
      assert.ok(width !== null, `size=${size} must declare an explicit w-* class`);
      assert.ok(height! >= 24, `size=${size} height ${height}px is under the 24px WCAG 2.2 2.5.8 minimum`);
      assert.ok(width! >= 24, `size=${size} width ${width}px is under the 24px WCAG 2.2 2.5.8 minimum`);
      assert.equal(height, ICON_SIZE_PX[size], `size=${size} height drifted from its documented pixel value`);
      assert.equal(width, ICON_SIZE_PX[size], `size=${size} width drifted from its documented pixel value`);
    }
  });

  it('carries no hit-slop pseudo-element on any size (that belongs at the call site, not the shared variant)', () => {
    for (const size of [...ICON_SIZES, 'default', 'sm', 'lg'] as const) {
      const classes = buttonVariants({ size });
      assert.doesNotMatch(
        classes,
        /after:absolute/,
        `size=${size} must not carry a shared hit-slop pseudo-element — it overlaps neighbouring toolbar buttons`,
      );
    }
  });
});
