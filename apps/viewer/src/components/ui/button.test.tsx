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
 * The icon-size hit-slop is a `relative` + `after:` pseudo-element pinned
 * with a negative inset, so it survives a caller shrinking the visual box
 * via a `className` override (`size="icon-sm" className="h-5 w-5"`, a real
 * pattern in this codebase — see e.g. MeasurementList.tsx) without touching
 * that caller's file: `cn()` only lets a later className win on classes that
 * target the SAME CSS property (tailwind-merge), and nothing in this
 * codebase sets `after:` or `relative`/`absolute` on a Button override, so
 * the hit-slop always survives.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buttonVariants } from './button.js';

const ICON_SIZES = ['icon', 'icon-sm', 'icon-xs'] as const;
const ALL_VARIANTS = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const;

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

  it('gives every icon size a hit-slop pseudo-element that survives a smaller visual box', () => {
    for (const size of ICON_SIZES) {
      const classes = buttonVariants({ size });
      assert.match(classes, /\brelative\b/, `size=${size} needs position:relative for the hit-slop pseudo`);
      assert.match(
        classes,
        /after:absolute/,
        `size=${size} needs an absolutely positioned ::after for the hit-slop`,
      );
      assert.match(
        classes,
        /after:-inset-2/,
        `size=${size} needs a negative inset pulling the hit-slop outward from the (possibly shrunk) visual box`,
      );
      assert.match(
        classes,
        /after:content-\[.?"?.?\]/,
        `size=${size}'s ::after needs content to actually generate a box`,
      );
    }
  });

  it('leaves the non-icon sizes without hit-slop (their own visual box already clears 24px)', () => {
    for (const size of ['default', 'sm', 'lg'] as const) {
      const classes = buttonVariants({ size });
      assert.doesNotMatch(
        classes,
        /after:absolute/,
        `size=${size} does not need hit-slop and should not carry the pseudo-element cost`,
      );
    }
  });
});
