/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { CONTRAST_BROWSER_SKIP, closeContrastBrowser, warmContrastBrowser, withThemedPage } from '@/test/contrast/render-harness.js';
import { ViewportOverlays } from './ViewportOverlays';
import { MobilePanelLauncher } from './MobilePanelLauncher';
import { MobileToolbar } from './MobileToolbar';
import { classifyFormFactor } from '@/lib/layout/form-factor';

before(warmContrastBrowser);
after(closeContrastBrowser);
afterEach(cleanup);

// Preserve #8802 control clearance while docking compact progress at bottom right.
for (const [width, height] of [[320, 640], [360, 740], [375, 553], [390, 844], [568, 320], [592, 360], [639, 360], [1280, 800], [1600, 1000]]) {
  for (const theme of ['light', 'dark'] as const) {
    for (const cancel of [true, false]) {
      it(`loading card clears viewport controls at ${width}x${height}, ${theme}, cancel=${cancel} (#8802)`, { skip: CONTRAST_BROWSER_SKIP }, async () => {
        const phone = width < 640;
        act(() => useViewerStore.setState({
          formFactor: classifyFormFactor({ width, height, coarsePointer: phone }), isMobile: phone, loading: true, error: null, cesiumEnabled: false,
          loadingFileName: 'building-architecture-rev-b.ifc',
          geometryProgress: { phase: 'Processing geometry and preparing a longer phase description', percent: 42 },
          activeLoadCanceller: cancel ? () => {} : null,
        }));
        const ui = render(<TooltipProvider>
          <div style={{ width, height, display: 'flex', flexDirection: 'column' }}>
            <div data-test-toolbar><MobileToolbar /></div>
            <div data-test-viewport style={{ position: 'relative', flex: 1 }}>
              <ViewportOverlays />
              {phone && <MobilePanelLauncher />}
            </div>
          </div>
        </TooltipProvider>);
        const html = ui.innerHTML;
        cleanup();
        const result = await withThemedPage(theme, html, async (page) => {
          await page.setViewportSize({ width, height });
          await page.evaluate('globalThis.__name = (fn) => fn;');
          return page.evaluate(() => {
            const card = document.querySelector('[data-viewport-loading-card]')!;
            const rect = card.getBoundingClientRect();
            const home = document.querySelector('button[aria-label="Home view"]');
            const panels = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Panels');
            const cube = document.querySelector('[data-tour="viewcube"]');
            const toolbar = document.querySelector('[data-test-toolbar]')!;
            const targets = [home?.parentElement, panels, cube, toolbar].filter((el): el is Element => !!el);
            const overlaps = targets.map(el => {
              const other = el.getBoundingClientRect();
              return rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top;
            });
            const viewport = document.querySelector('[data-test-viewport]')!.getBoundingClientRect();
            return {
              overlaps, targets: targets.length, width: rect.width,
              top: rect.top - viewport.top,
              right: viewport.right - rect.right,
              bottom: viewport.bottom - rect.bottom,
              font: parseFloat(getComputedStyle(card.querySelector('output')!).fontSize),
            };
          });
        });
        assert.equal(result.targets, phone ? 4 : 2, 'all expected controls were measured');
        assert.equal(result.overlaps.some(Boolean), false, `overlap flags: ${result.overlaps.join(',')}`);
        assert.ok(result.font >= 11, `font ${result.font}`);
        assert.ok(result.width <= 180, `compact indicator width ${result.width}`);
        assert.equal(result.right, 16, 'anchors at the right viewport gutter');
        assert.equal(result.bottom, phone ? 64 : 16, 'clears the mobile navigation row');
      });
    }
  }
}
