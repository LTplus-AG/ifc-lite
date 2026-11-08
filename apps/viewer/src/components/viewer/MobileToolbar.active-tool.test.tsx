/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The phone toolbar's active tool wears the shared active state (#8802), as
 * every other selected option does since R4: a tinted surface, `active` ink
 * and an inset edge, keyed off `aria-pressed`. It used a solid primary fill,
 * which the app reserves for a panel's one next action.
 *
 * The real toolbar is mounted (happy-dom), then its markup is painted in real
 * Chrome with the compiled app stylesheet in light, dark and colorful. Only
 * strings, numbers and booleans leave the page, never an element.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, click, render } from '@/test/render';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage, type Theme } from '@/test/contrast/render-harness.js';
import { MobileToolbar } from './MobileToolbar';

const THEMES: readonly Theme[] = ['light', 'dark', 'colorful'];
const TOOLS = ['tool:select', 'tool:measure', 'tool:section'] as const;
/** The toolbar's height and its buttons' size, unchanged by the restyle. */
const TOOLBAR_HEIGHT_PX = 44;
const TOOL_BUTTON_PX = 36;

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(initial);
});

function mountToolbar(activeTool: 'select' | 'measure' = 'select'): HTMLElement {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('model', { idOffset: 0 })), loading: false, activeTool });
  return render(
    <BimReactContext.Provider value={{} as BimContext}>
      <MobileToolbar />
    </BimReactContext.Provider>,
  );
}

function pressedTools(ui: HTMLElement): string[] {
  return TOOLS.map((id) => `${id}=${ui.querySelector(`[data-command-id="${id}"]`)?.getAttribute('aria-pressed') ?? 'missing'}`);
}

it('announces exactly the active phone tool as pressed, and follows a tool switch (#8802)', () => {
  const ui = mountToolbar();
  assert.deepEqual(pressedTools(ui), ['tool:select=true', 'tool:measure=false', 'tool:section=false']);
  const measure = ui.querySelector<HTMLElement>('[data-command-id="tool:measure"]');
  assert.equal(measure !== null, true, 'the Measure tool button is rendered');
  click(measure!);
  assert.equal(useViewerStore.getState().activeTool, 'measure');
  assert.deepEqual(pressedTools(ui), ['tool:select=false', 'tool:measure=true', 'tool:section=false']);
});

interface Paint { background: string; color: string; shadow: string }
interface ToolbarPaint {
  active: Paint;
  resting: Paint;
  refActive: Paint;
  refPrimary: Paint;
  toolbarHeight: number;
  buttonSizes: number[];
}

describe('the active phone tool paints the shared active state (#8802)', () => {
  before(warmContrastBrowser);
  after(closeContrastBrowser);
  for (const theme of THEMES) {
    it(`in ${theme}`, async () => {
      const ui = mountToolbar('measure');
      const html = ui.innerHTML;
      cleanup();
      const refs = `
        <button id="ref-active" class="bg-active-surface text-active ring-1 ring-inset ring-active-border">ref</button>
        <button id="ref-primary" class="bg-primary text-primary-foreground">ref</button>`;
      const painted = await withThemedPage(theme, `<div style="width:390px">${html}</div>${refs}`, async (page): Promise<ToolbarPaint> => {
        await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
        await page.evaluate('globalThis.__name = (fn) => fn;');
        return page.evaluate((tools) => {
          const paintOf = (selector: string) => {
            const style = getComputedStyle(document.querySelector(selector)!);
            return { background: style.backgroundColor, color: style.color, shadow: style.boxShadow };
          };
          const bar = document.querySelector('[data-command-surface="mobile"]')!;
          return {
            active: paintOf('[data-command-id="tool:measure"]'),
            resting: paintOf('[data-command-id="tool:select"]'),
            refActive: paintOf('#ref-active'),
            refPrimary: paintOf('#ref-primary'),
            toolbarHeight: Math.round(bar.getBoundingClientRect().height),
            buttonSizes: tools.flatMap((id) => {
              const box = document.querySelector(`[data-command-id="${id}"]`)!.getBoundingClientRect();
              return [Math.round(box.width), Math.round(box.height)];
            }),
          };
        }, [...TOOLS]);
      });

      assert.equal(painted.active.background, painted.refActive.background, `${theme}: active tool paints the active surface`);
      assert.equal(painted.active.color, painted.refActive.color, `${theme}: active tool paints the active ink`);
      assert.equal(painted.active.shadow, painted.refActive.shadow, `${theme}: active tool carries the inset active edge`);
      assert.notEqual(painted.active.background, painted.refPrimary.background, `${theme}: active tool is not the solid primary fill`);
      assert.notEqual(painted.resting.background, painted.refActive.background, `${theme}: a resting tool is not painted active`);
      assert.equal(painted.toolbarHeight, TOOLBAR_HEIGHT_PX, `${theme}: toolbar keeps its height`);
      assert.deepEqual(painted.buttonSizes, TOOLS.flatMap(() => [TOOL_BUTTON_PX, TOOL_BUTTON_PX]), `${theme}: tool buttons keep their size`);
    });
  }
});
