/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every phone toolbar button is a 44x44 px target (#8802), in one row, at a
 * 390px phone and at the narrowest supported 320px one. The buttons were 36px.
 * Nine 44px targets need 396px, so Add model and Show all moved into More
 * (maintainer's decision); the seven left keep a 36px face with an invisible
 * extension. The same holds while a model loads: the load progress used to sit
 * in the row and, at 320px, pushed More off-screen and made the bar scroll
 * (PR 9313 review); it is now a line along the bar's bottom edge.
 *
 * The real toolbar is mounted (happy-dom) with a model loaded, then laid out
 * in real Chrome with the compiled app stylesheet, in a page whose viewport is
 * the phone's width. Each target is measured with `elementFromPoint`, so the
 * measure is what a finger can actually hit: it sees the invisible extension,
 * clipping by the bar, and a neighbour's extension overlapping it.
 * - 25 sample points (a 5x5 grid) across the 44x44 square centred on the face,
 *   its edges included;
 * - the hit area's width and height through the face's centre, walked pixel by
 *   pixel until a probe leaves the button.
 * Only strings, numbers and booleans leave the page, never an element.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage } from '@/test/contrast/render-harness.js';
import { MobileToolbar } from './MobileToolbar';
import { classifyFormFactor, mobileCommandPlacement, type MobileCommandPlacement } from '@/lib/layout/form-factor';

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

interface TargetProbe { label: string; missed: number; probes: number; hitWidth: number; hitHeight: number }
interface ToolbarLayout {
  buttons: number;
  disabled: string[];
  rows: number;
  columns: number;
  scrolls: boolean;
  moreInside: boolean;
  moreSpan: string;
  progress: { present: boolean; isProgressbar: boolean; value: number | null; label: string | null; height: number };
  targets: TargetProbe[];
}

/** Lays the bar out as the shell does: a row under the viewport, or a rail on the right of a short screen. */
async function layoutAt(html: string, width: number, height = 844, placement: MobileCommandPlacement = 'bottom-bar'): Promise<ToolbarLayout> {
  const shell = placement === 'side-rail'
    ? `<div style="width:${width}px;height:${height}px;display:flex"><div style="flex:1"></div>${html}</div>`
    : `<div style="width:${width}px">${html}</div>`;
  return withThemedPage('light', shell, async (page) => {
    await page.setViewportSize({ width, height });
    await page.evaluate('globalThis.__name = (fn) => fn;');
    return page.evaluate(({ target, phone }) => {
      const bar = document.querySelector('[data-command-surface="mobile"]') as HTMLElement;
      const buttons = [...bar.querySelectorAll('button')].filter((button) => button.getBoundingClientRect().width > 0);
      const more = bar.querySelector('[data-command-disclosure="mobile:more"]')?.getBoundingClientRect();
      const progress = bar.querySelector<HTMLElement>('[data-mobile-load-progress]');
      // Probe whole pixels: Chrome hit-tests a fractional point at a whole
      // pixel, so a half-pixel probe on a target's last column lands on its
      // neighbour. These five offsets cover the first and last of the 44
      // pixel columns (and rows) of the square centred on the face.
      const offsets = [0, 11, 22, 33, target - 1];
      return {
        buttons: buttons.length,
        disabled: buttons.filter((button) => button.disabled).map((button) => button.getAttribute('aria-label') ?? ''),
        rows: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size,
        columns: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().left))).size,
        scrolls: bar.scrollWidth > bar.clientWidth || bar.scrollHeight > bar.clientHeight,
        // The whole of More, not part of it, inside the phone's viewport.
        moreInside: !!more && more.left >= 0 && more.right <= Math.min(phone, document.documentElement.clientWidth) && more.width > 0
          && more.top >= 0 && more.bottom <= document.documentElement.clientHeight,
        moreSpan: more ? `${Math.round(more.left)}-${Math.round(more.right)}px` : 'missing',
        progress: {
          present: !!progress,
          // A native <progress> is a progressbar to assistive tech.
          isProgressbar: !!progress && (progress.tagName === 'PROGRESS' || progress.getAttribute('role') === 'progressbar'),
          value: progress instanceof HTMLProgressElement && progress.hasAttribute('value') ? progress.value
            : progress?.hasAttribute('aria-valuenow') ? Number(progress.getAttribute('aria-valuenow')) : null,
          label: progress?.getAttribute('aria-label') ?? null,
          height: Math.round(progress?.getBoundingClientRect().height ?? 0),
        },
        // A disabled button (Open while a model loads) takes no taps, so it is
        // not a target; every enabled one is probed.
        targets: buttons.filter((button) => !button.disabled).map((button) => {
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
          // The hit area's extent through the face's centre, one whole pixel at a time.
          const cx = Math.round(box.left + box.width / 2);
          const cy = Math.round(box.top + box.height / 2);
          const owns = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('button') === button;
          const reach = (dx: number, dy: number) => {
            let n = 0;
            while (n < 2 * target && owns(cx + dx * (n + 1), cy + dy * (n + 1))) n += 1;
            return n;
          };
          const hitWidth = owns(cx, cy) ? reach(-1, 0) + 1 + reach(1, 0) : 0;
          const hitHeight = owns(cx, cy) ? reach(0, -1) + 1 + reach(0, 1) : 0;
          return { label: `${button.getAttribute('aria-label') ?? ''} [${misses.slice(0, 5).join('; ')}]`, missed, probes: offsets.length * offsets.length, hitWidth, hitHeight };
        }),
      };
    }, { target: TARGET_PX, phone: width });
  });
}

function toolbarHtml(placement?: MobileCommandPlacement): string {
  const ui = render(
    <BimReactContext.Provider value={{} as BimContext}>
      <MobileToolbar placement={placement} />
    </BimReactContext.Provider>,
  );
  const html = ui.innerHTML;
  cleanup();
  return html;
}

function assertTargetsFit(layout: ToolbarLayout, width: number, expected = EXPECTED_BUTTONS, line: 'rows' | 'columns' = 'rows'): void {
  assert.equal(layout.buttons, expected, `${width}px: the bar holds ${expected === EXPECTED_BUTTONS ? 'Open, Select, Measure, Section, Home, Fit and More' : `${expected} buttons`}`);
  assert.equal(layout[line], 1, `${width}px: one ${line === 'rows' ? 'row' : 'column'}`);
  assert.equal(layout.scrolls, false, `${width}px: the bar does not scroll`);
  assert.equal(layout.moreInside, true, `${width}px: More actions (${layout.moreSpan}) is inside the phone`);
  const short = layout.targets.filter((probe) => probe.missed > 0).map((probe) => `${probe.label} (${probe.missed}/${probe.probes} probes missed)`);
  assert.deepEqual(short, [], `${width}px: every target answers at all 25 sample points of its ${TARGET_PX}x${TARGET_PX} square`);
  const narrow = layout.targets.filter((probe) => probe.hitWidth < TARGET_PX || probe.hitHeight < TARGET_PX)
    .map((probe) => `${probe.label.split(' [')[0]} ${probe.hitWidth}x${probe.hitHeight}`);
  assert.deepEqual(narrow, [], `${width}px: every target's hit area measures at least ${TARGET_PX}x${TARGET_PX} through its centre`);
}

describe('phone toolbar targets (#8802)', () => {
  for (const width of PHONE_WIDTHS) {
    it(`at rest, every phone toolbar button is a 44x44 target in one row at ${width}px`, async () => {
      useViewerStore.setState({ ...fixtureModels(fixtureModel('model', { idOffset: 0 })), loading: false, activeTool: 'select' });
      const layout = await layoutAt(toolbarHtml(), width);
      assertTargetsFit(layout, width);
      assert.deepEqual(layout.disabled, [], `${width}px: nothing is disabled at rest`);
      assert.equal(layout.progress.present, false, `${width}px: no load progress at rest`);
    });
  }

  for (const width of PHONE_WIDTHS) {
    it(`while another model loads at ${width}px, the bar still fits, More stays fully reachable and progress is shown and announced`, async () => {
      useViewerStore.setState({
        ...fixtureModels(fixtureModel('model', { idOffset: 0 })),
        activeTool: 'select',
        loading: true,
        progress: { phase: 'Loading file', percent: 5 },
        metadataProgress: null,
        geometryProgress: { phase: 'Processing geometry', percent: 42 },
      });
      const layout = await layoutAt(toolbarHtml(), width);
      assertTargetsFit(layout, width);
      assert.deepEqual(layout.disabled, ['Open file'], `${width}px: only Open waits for the load`);
      assert.equal(layout.targets.length, EXPECTED_BUTTONS - 1, `${width}px: the six enabled buttons are all probed`);
      assert.equal(layout.progress.present, true, `${width}px: load progress is shown`);
      assert.equal(layout.progress.isProgressbar, true, `${width}px: progress is exposed as a progressbar`);
      assert.equal(layout.progress.value, 42, `${width}px: progress reports the active phase's percentage`);
      assert.ok(layout.progress.label, `${width}px: progress has an accessible name`);
      assert.ok(layout.progress.height > 0, `${width}px: progress is visible (${layout.progress.height}px tall)`);
    });
  }
});

describe('phone toolbar placements (#9718)', () => {
  it('on a phone on its side (960x412) the commands are one 44px column on the right, with nothing scrolling', async () => {
    const formFactor = classifyFormFactor({ width: 960, height: 412, coarsePointer: true });
    useViewerStore.setState({ ...fixtureModels(fixtureModel('model', { idOffset: 0 })), loading: false, activeTool: 'select', isMobile: true, formFactor });
    const placement = mobileCommandPlacement(formFactor);
    assert.equal(placement, 'side-rail');
    const layout = await layoutAt(toolbarHtml(placement), 960, 412, placement);
    assertTargetsFit(layout, 960, EXPECTED_BUTTONS, 'columns');
  });

  it('on a 352px cover screen Home and Fit move into More, and the bar does not scroll', async () => {
    const formFactor = classifyFormFactor({ width: 352, height: 400, coarsePointer: true });
    assert.equal(formFactor.compactCommands, true);
    useViewerStore.setState({ ...fixtureModels(fixtureModel('model', { idOffset: 0 })), loading: false, activeTool: 'select', isMobile: true, formFactor });
    const html = toolbarHtml();
    assert.doesNotMatch(html, /data-command-id="view:home"/, 'Home is not in the bar');
    const layout = await layoutAt(html, 352, 400);
    // Open, Select, Measure, Section, More.
    assertTargetsFit(layout, 352, EXPECTED_BUTTONS - 2);
  });

  it('a 360x400 cover screen keeps all seven targets in the row', async () => {
    const formFactor = classifyFormFactor({ width: 360, height: 400, coarsePointer: true });
    useViewerStore.setState({ ...fixtureModels(fixtureModel('model', { idOffset: 0 })), loading: false, activeTool: 'select', isMobile: true, formFactor });
    assertTargetsFit(await layoutAt(toolbarHtml(), 360, 400), 360);
  });
});
