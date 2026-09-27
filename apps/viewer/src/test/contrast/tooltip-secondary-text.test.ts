/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measures the REAL WCAG contrast ratio of every tooltip secondary-text line
 * against the REAL `TooltipContent` popover surface, in light, dark and
 * `.colorful` — the check that would have caught #4783 (three components
 * hardcoding `text-primary-foreground` after #4767 moved the shared
 * `TooltipContent` surface to `bg-popover`, leaving invisible text in every
 * theme). #4767's own test and #4784's fix both assert className *strings*
 * in `happy-dom`, which loads no stylesheet — see those files' own doc
 * comments for why that cannot see this class of bug. This test renders the
 * app's actual compiled Tailwind CSS in real headless Chromium
 * (`render-harness.ts`) and computes an actual contrast ratio.
 *
 * Each secondary-text `className` is pulled from the component's SOURCE
 * (`extract-classname.ts`), not hardcoded here — so a future edit that
 * changes the class (the way #4767 unknowingly did to these three
 * components) is exactly what turns this test red, not a className this
 * file guessed at.
 *
 * THRESHOLD: WCAG AA for NORMAL text is 4.5:1 (large text — >=18pt/24px, or
 * >=14pt/18.66px bold — only needs 3:1). Every element measured here renders
 * at 10px (`text-[10px]`) or inherits a `text-xs`/small ancestor, so normal
 * text's 4.5:1 is the applicable bar, never the relaxed large-text one.
 *
 * NON-VACUOUSNESS: the "REGRESSION" cases below render foreground equal to
 * the popover surface and prove the real-browser harness detects invisible
 * text in every theme. The old #4783 fixture used
 * `text-primary-foreground/{70,80}`, but #4792 intentionally gave that token
 * sufficient contrast, so it is no longer a valid negative control.
 * BsddCard's dataType line was itself a known gap
 * (`text-muted-foreground/80` measured 3.29:1 in light theme, below AA)
 * until the `/80` was dropped to match the sibling description line; the
 * same fixedCases assertion below reddens if `/80` (or any other opacity
 * reduction) is reintroduced on that line.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureTooltipTextContrast, closeContrastBrowser, type Theme } from './render-harness';
import { extractClassNameAfter } from './extract-classname';
import { WCAG_AA_NORMAL_TEXT } from './wcag';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = join(__dirname, '../../components/viewer/properties');
const QUANTITY_SET_CARD = join(COMPONENTS_DIR, 'QuantitySetCard.tsx');
const PROPERTY_SET_CARD = join(COMPONENTS_DIR, 'PropertySetCard.tsx');
const BSDD_CARD = join(COMPONENTS_DIR, 'BsddCard.tsx');
const COUNT_BADGE_TOOLTIP = join(__dirname, '../../components/viewer/hierarchy/CountBadgeTooltip.tsx');

const THEMES: Theme[] = ['light', 'dark', 'colorful'];

after(async () => {
  await closeContrastBrowser();
});

describe('tooltip secondary text meets WCAG AA on the real popover surface (#4783)', () => {
  // These three all fix onto `text-muted-foreground` (#4784) and clear AA
  // normal-text (4.5:1) with real margin in every theme (measured floor,
  // light theme: 4.83:1). If a future edit reverts any of them toward
  // `text-primary-foreground` again, this reddens exactly as it did for
  // #4783 — see the REGRESSION describe block below for the proof.
  const fixedCases: Array<{ name: string; file: string; anchor: string }> = [
    {
      name: 'QuantitySetCard quantity-type tooltip',
      file: QUANTITY_SET_CARD,
      anchor: '<TooltipContent side="top" className="text-2xs">',
    },
    {
      name: 'PropertySetCard IFC-type tooltip',
      file: PROPERTY_SET_CARD,
      anchor: '<TooltipContent side="top" className="text-2xs">',
    },
    {
      name: 'BsddCard property description',
      file: BSDD_CARD,
      anchor: '{prop.description && <p ',
    },
    {
      name: 'BsddCard property dataType',
      file: BSDD_CARD,
      anchor: '{prop.dataType && <p ',
    },
    {
      name: 'CountBadgeTooltip breakdown line',
      file: COUNT_BADGE_TOOLTIP,
      anchor: '<p key={line} ',
    },
  ];

  for (const { name, file, anchor } of fixedCases) {
    for (const theme of THEMES) {
      it(`${name} clears AA (${WCAG_AA_NORMAL_TEXT}:1) in ${theme} theme`, async () => {
        const className = extractClassNameAfter(file, anchor);
        const ratio = await measureTooltipTextContrast(theme, className);
        assert.ok(
          ratio >= WCAG_AA_NORMAL_TEXT,
          `expected >= ${WCAG_AA_NORMAL_TEXT}:1, measured ${ratio.toFixed(2)}:1 for className="${className}" in ${theme} theme`,
        );
      });
    }
  }
});

describe('non-vacuousness proof: invisible tooltip text reddens in every theme', () => {
  // `text-popover` resolves to the same color as TooltipContent's
  // `bg-popover`. It is deliberately independent of the primary token this
  // issue repairs, so improving that token cannot silently invalidate the
  // harness's negative control again.
  const className = 'text-popover';

  for (const theme of THEMES) {
    it(`matching foreground and surface in ${theme} theme measures near 1:1`, async () => {
      const ratio = await measureTooltipTextContrast(theme, className);
      assert.ok(
        ratio < WCAG_AA_NORMAL_TEXT,
        `expected invisible tooltip text to measure below AA; got ${ratio.toFixed(2)}:1 — ` +
          'either the harness stopped measuring correctly or the negative-control class no longer matches the surface',
      );
      assert.ok(ratio < 1.5, `expected near-invisible (~1:1), got ${ratio.toFixed(2)}:1`);
    });
  }
});
