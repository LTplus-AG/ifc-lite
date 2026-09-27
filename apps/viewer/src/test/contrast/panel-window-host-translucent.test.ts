/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measures the REAL WCAG contrast ratio of `PanelWindowHost`'s two
 * header/footer hints (#4825's second acknowledged harness gap) against
 * their REAL composited surface — a translucent `bg-muted/40` (header) /
 * `bg-muted/30` (footer) layered over the popped-out window's ancestor
 * `bg-background` — in light, dark and `.colorful`.
 *
 * `render-harness.ts`'s `measureTextContrastOnSurface` previously measured
 * only a surface's own (initial) background, resolved "over itself" —
 * correct for the app's other panel surfaces (`bg-background`, `bg-popover`,
 * `bg-card`, ...), all fully opaque, but wrong for a translucent layer: it
 * never actually blends with anything underneath. `PanelWindowHost.tsx`'s
 * header (`bg-muted/40`) and footer (`bg-muted/30`) strips are the only
 * sites in this shape (#4825), so they were unmeasurable until the harness
 * gained an explicit `backdropClassName` parameter — see that file's doc
 * comment for how the compositing is done (reusing the same canvas
 * compositor already used to resolve translucent TEXT onto its surface,
 * rather than a second one for translucent SURFACES).
 *
 * Class names come from the rendered window chrome. The footer's text color
 * is inherited from its surface, so its text class is empty in the contrast
 * probe; the header hint supplies its own text class.
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render, cleanup } from '@/test/render.js';
import { resolve } from '@/i18n/registry';
import { PanelWindowChromeShell } from '@/components/viewer/dock/PanelWindowHost.js';
import { measureTextContrastOnSurface, closeContrastBrowser, type Theme } from './render-harness';
import { WCAG_AA_NORMAL_TEXT } from './wcag';

const THEMES: Theme[] = ['light', 'dark', 'colorful'];

interface ChromeClasses {
  backdrop: string;
  headerSurface: string;
  headerText: string;
  footerSurface: string;
}

let mountedClasses: ChromeClasses | undefined;

function readChromeClasses(): ChromeClasses {
  if (mountedClasses) return mountedClasses;
  const container = render(createElement(PanelWindowChromeShell, {
    title: 'Contrast test panel', kind: 'popup', onDock: () => {}, onClose: () => {},
    children: createElement('div'),
  }));
  const root = container.firstElementChild;
  assert.ok(root instanceof HTMLElement, 'window chrome is rendered');
  const spans = [...root.querySelectorAll('span')];
  const headerHint = spans.find((span) => span.textContent?.trim() === resolve('shellChrome.panelWindowHost.kindWindow'));
  const footerHint = spans.find((span) => span.textContent?.trim() === resolve('shellChrome.panelWindowHost.liveSyncedNotice'));
  assert.ok(headerHint?.parentElement, 'window-kind hint is rendered in its header surface');
  assert.ok(footerHint?.parentElement, 'live-sync hint is rendered in its footer surface');
  mountedClasses = {
    backdrop: root.className,
    headerSurface: headerHint.parentElement.className,
    headerText: headerHint.className,
    footerSurface: footerHint.parentElement.className,
  };
  return mountedClasses;
}

after(async () => {
  cleanup();
  await closeContrastBrowser();
});

describe('PanelWindowHost translucent header/footer hints meet WCAG AA on their composited surface (#4825)', () => {
  const fixedCases: Array<{ name: string; part: 'header' | 'footer' }> = [
    { name: 'header "Window"/"Picture-in-picture" hint', part: 'header' },
    { name: 'footer "Live · synced with the main window" strip', part: 'footer' },
  ];

  for (const { name, part } of fixedCases) {
    for (const theme of THEMES) {
      it(`${name} clears AA (${WCAG_AA_NORMAL_TEXT}:1) in ${theme} theme`, async () => {
        const classes = readChromeClasses();
        const surfaceClassName = part === 'header' ? classes.headerSurface : classes.footerSurface;
        const textClassName = part === 'header' ? classes.headerText : '';
        const ratio = await measureTextContrastOnSurface(theme, surfaceClassName, textClassName, classes.backdrop);
        assert.ok(
          ratio >= WCAG_AA_NORMAL_TEXT,
          `expected >= ${WCAG_AA_NORMAL_TEXT}:1, measured ${ratio.toFixed(2)}:1 for surface="${surfaceClassName}" ` +
            `text="${textClassName}" over backdrop="${classes.backdrop}" in ${theme} theme`,
        );
      });
    }
  }
});

describe('non-vacuousness proof: reintroducing the pre-#4825 /70 opacity tier reddens in every theme', () => {
  // Not extracted from source — deliberately renders the OLD, pre-fix
  // `text-muted-foreground/70` classes these two sites shipped, over their
  // real composited surface, to prove the harness and threshold actually
  // catch the regression rather than passing regardless of input.
  const regressedCases: Array<{ name: string; surface: string; text: string }> = [
    {
      name: 'header hint (pre-#4825, /70 over bg-muted/40)',
      surface: 'bg-muted/40',
      text: 'text-[9px] uppercase tracking-wide text-muted-foreground/70 shrink-0',
    },
    {
      name: 'footer strip (pre-#4825, /70 over bg-muted/30)',
      surface: 'bg-muted/30 text-[9px] text-muted-foreground/70',
      text: '',
    },
  ];

  for (const { name, surface, text } of regressedCases) {
    for (const theme of THEMES) {
      it(`${name} in ${theme} theme measures under AA (proves the harness is non-vacuous)`, async () => {
        const ratio = await measureTextContrastOnSurface(theme, surface, text, readChromeClasses().backdrop);
        assert.ok(
          ratio < WCAG_AA_NORMAL_TEXT,
          `expected the pre-#4825 regression to measure below AA; got ${ratio.toFixed(2)}:1 — ` +
            `either the harness stopped measuring correctly, or the theme tokens changed enough that ` +
            `this className is no longer a valid regression fixture`,
        );
      });
    }
  }
});
