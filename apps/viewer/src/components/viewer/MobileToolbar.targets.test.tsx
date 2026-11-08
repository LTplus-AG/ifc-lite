/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every phone toolbar button is a 44x44 px target (#8802), in one row, at a
 * 390px phone and at the narrowest supported 320px one. The buttons were 36px.
 * Nine 44px targets need 396px, so Add model and Show all moved into More
 * (maintainer's decision); the seven left keep a 36px face with an invisible
 * extension.
 *
 * The real toolbar is mounted (happy-dom) with a model loaded, then laid out
 * in real Chrome with the compiled app stylesheet. Each target is probed with
 * `elementFromPoint` over its whole 44x44 square, so the measure is what a
 * finger can actually hit: it sees the invisible extension, clipping by the
 * bar, and a neighbour's extension overlapping it. Only strings, numbers and
 * booleans leave the page, never an element.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage } from '@/test/contrast/render-harness.js';
import { MobileToolbar } from './MobileToolbar';

const TARGET_PX = 44;
const PHONE_WIDTHS = [390, 320] as const;
/** Open, Select, Measure, Section, Home, Fit, More. */
const EXPECTED_BUTTONS = 7;

const initial = useViewerStore.getState();
before(warmContrastBrowser);
after(closeContrastBrowser);
afterEach(() => {
  cleanup();
  useViewerStore.setState(initial);
});

interface TargetProbe { label: string; missed: number; probes: number }
interface ToolbarLayout { buttons: number; rows: number; scrolls: boolean; rightEdge: number; targets: TargetProbe[] }

async function layoutAt(html: string, width: number): Promise<ToolbarLayout> {
  return withThemedPage('light', `<div style="width:${width}px">${html}</div>`, async (page) => {
    await page.evaluate('globalThis.__name = (fn) => fn;');
    return page.evaluate((target) => {
      const bar = document.querySelector('[data-command-surface="mobile"]') as HTMLElement;
      const buttons = [...bar.querySelectorAll('button')].filter((button) => button.getBoundingClientRect().width > 0);
      // Probe whole pixels: Chrome hit-tests a fractional point at a whole
      // pixel, so a half-pixel probe on a target's last column lands on its
      // neighbour. These five offsets cover the first and last of the 44
      // pixel columns (and rows) of the square centred on the face.
      const offsets = [0, 11, 22, 33, target - 1];
      return {
        buttons: buttons.length,
        rows: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size,
        scrolls: bar.scrollWidth > bar.clientWidth,
        rightEdge: Math.round(Math.max(...buttons.map((button) => button.getBoundingClientRect().right))),
        targets: buttons.map((button) => {
          const box = button.getBoundingClientRect();
          const x0 = Math.round(box.left + box.width / 2 - target / 2);
          const y0 = Math.round(box.top + box.height / 2 - target / 2);
          let missed = 0;
          const misses: string[] = [];
          for (const dx of offsets) {
            for (const dy of offsets) {
              const at = document.elementFromPoint(x0 + dx, y0 + dy);
              if (at?.closest('button') === button) continue;
              missed += 1;
              const other = at?.closest('button')?.getAttribute('aria-label');
              misses.push(`(+${dx},+${dy}) hit ${other ?? at?.tagName ?? 'nothing'}`);
            }
          }
          return { label: `${button.getAttribute('aria-label') ?? ''} [${misses.slice(0, 5).join('; ')}]`, missed, probes: offsets.length * offsets.length };
        }),
      };
    }, TARGET_PX);
  });
}

it('every phone toolbar button is a 44x44 target in one row at 390 and 320px (#8802)', async () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('model', { idOffset: 0 })), loading: false, activeTool: 'select' });
  const ui = render(
    <BimReactContext.Provider value={{} as BimContext}>
      <MobileToolbar />
    </BimReactContext.Provider>,
  );
  const html = ui.innerHTML;
  cleanup();

  for (const width of PHONE_WIDTHS) {
    const layout = await layoutAt(html, width);
    assert.equal(layout.buttons, EXPECTED_BUTTONS, `${width}px: the bar holds Open, Select, Measure, Section, Home, Fit and More`);
    assert.equal(layout.rows, 1, `${width}px: one row`);
    assert.equal(layout.scrolls, false, `${width}px: the bar does not scroll`);
    assert.ok(layout.rightEdge <= width, `${width}px: the last button ends at ${layout.rightEdge}px, inside the phone`);
    const short = layout.targets.filter((probe) => probe.missed > 0).map((probe) => `${probe.label} (${probe.missed}/${probe.probes} probes missed)`);
    assert.deepEqual(short, [], `${width}px: every target answers across its whole ${TARGET_PX}x${TARGET_PX} square`);
  }
});
