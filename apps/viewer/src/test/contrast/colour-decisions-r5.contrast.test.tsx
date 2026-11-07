/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The #8802 R5 colour decisions, measured on mounted components.
 *
 * Each case mounts real viewer components (happy-dom), then paints that DOM in
 * real Chrome with the compiled app stylesheet, in light, dark and colorful:
 *
 * 1. a selected option wears the shared active state, not a solid primary
 *    fill (the solid fill is reserved for a panel's one next action), and its
 *    label clears 4.5:1 on that state;
 * 2. a solid status fill (a pass-rate bar) paints its role's solid token,
 *    which clears 3:1 as an indicator against the panel, the raised surface
 *    and the input well, and `solid-foreground` clears 4.5:1 on every fill;
 * 3. a selected tab keeps the active state in dark, where a global
 *    `[data-state="active"]` reset is `!important`;
 * 4. a text link is neutral ink that clears 4.5:1 and stays underlined.
 *
 * Every surface is composited the way Chrome paints it: each ancestor's
 * background, translucent tints included, over white.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ACTIVE_TAB_CLASS } from '@/components/ui/active-state';
import { TEXT_LINK_CLASS } from '@/components/ui/text-link';
import { CombinatorToggle } from '@/components/viewer/FilterRuleControls';
import { SettingsChoice } from '@/components/viewer/settings/SettingsGroup';
import { PassRateBar } from '@/components/viewer/IDSPanelStatus';
import { PresentationViewCard } from '@/components/viewer/presentation/PresentationViewCard';
import { mapInkClass, mapInkStyle, pickedPinElement } from '@/components/viewer/properties/location-map-ink';
import { cleanup, render } from '@/test/render.js';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage, type Theme } from './render-harness.js';
import { contrastRatio, parseRgba } from './wcag.js';

const THEMES: readonly Theme[] = ['light', 'dark', 'colorful'];
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;
const ROLES = ['danger', 'warn', 'ok', 'info'] as const;

before(warmContrastBrowser);
afterEach(cleanup);
after(closeContrastBrowser);

/** What each token paints in the theme under test. */
const REFERENCES = `
  <div id="ref-plain">ref</div>
  <div id="ref-active" class="bg-active-surface text-active">ref</div>
  <div id="ref-primary" class="bg-primary text-primary-foreground">ref</div>
  ${ROLES.map((role) => `<div id="ref-${role}-solid" class="bg-${role}-solid text-solid-foreground">ref</div>`).join('')}
`;

interface Painted {
  color: string;
  background: string;
  underline: string;
  /** Opaque composited colours, [r, g, b]. */
  surface: number[];
  ink: number[];
}

/** Paints `bodyHtml` (plus the reference swatches) and reads `selectors`. */
async function paint(theme: Theme, bodyHtml: string, selectors: Record<string, string>): Promise<Record<string, Painted>> {
  return withThemedPage(theme, `${bodyHtml}${REFERENCES}`, async (page) => {
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    // tsx's esbuild `keepNames` wraps named helpers in `__name()`, which the page lacks.
    await page.evaluate('globalThis.__name = (fn) => fn;');
    return page.evaluate((wanted) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const read = () => Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
      const surfaceOf = (el: Element) => {
        const layers: Element[] = [];
        for (let a: Element | null = el; a; a = a.parentElement) layers.unshift(a);
        ctx.fillStyle = 'rgb(255, 255, 255)';
        ctx.fillRect(0, 0, 1, 1);
        for (const layer of layers) {
          ctx.fillStyle = getComputedStyle(layer).backgroundColor;
          ctx.fillRect(0, 0, 1, 1);
        }
        return read();
      };
      const out: Record<string, unknown> = {};
      for (const [name, selector] of Object.entries(wanted)) {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`no element for ${name} (${selector})`);
        const style = getComputedStyle(el);
        const surface = surfaceOf(el);
        // Text is painted at its own and its ancestors' opacity.
        let opacity = 1;
        for (let a: Element | null = el; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity);
        ctx.fillStyle = `rgb(${surface[0]}, ${surface[1]}, ${surface[2]})`;
        ctx.fillRect(0, 0, 1, 1);
        ctx.globalAlpha = opacity;
        ctx.fillStyle = style.color;
        ctx.fillRect(0, 0, 1, 1);
        ctx.globalAlpha = 1;
        out[name] = { color: style.color, background: style.backgroundColor, underline: style.textDecorationLine, surface, ink: read() };
      }
      return out as Record<string, Painted>;
    }, selectors);
  });
}

const rgb = (c: number[]) => ({ r: c[0], g: c[1], b: c[2], a: 1 });
const ratio = (a: number[], b: number[]) => contrastRatio(rgb(a), rgb(b));

function assertClears(label: string, measured: number, threshold: number, theme: Theme) {
  assert.ok(measured >= threshold, `${label} in ${theme}: ${measured.toFixed(2)}:1, expected >= ${threshold}:1`);
}

/** The element paints the active state and not the solid primary fill. */
function assertActiveNotPrimary(name: string, p: Record<string, Painted>, theme: Theme) {
  assert.notEqual(p.refActive.color, p.refPlain.color, `text-active in ${theme} paints its own ink`);
  assert.equal(p[name].color, p.refActive.color, `${name} in ${theme} paints the active ink`);
  assert.equal(p[name].background, p.refActive.background, `${name} in ${theme} paints the active surface`);
  assert.notEqual(p[name].background, p.refPrimary.background, `${name} in ${theme} is not a solid primary fill`);
  assertClears(`${name} label`, ratio(p[name].ink, p[name].surface), AA_TEXT, theme);
}

const REFS = {
  refPlain: '#ref-plain', refActive: '#ref-active', refPrimary: '#ref-primary',
  ...Object.fromEntries(ROLES.map((role) => [`ref-${role}`, `#ref-${role}-solid`])),
};

describe('R5 colour decisions (Refs 8802)', () => {
  for (const theme of THEMES) {
    it(`a selected option in a validation/filter switch wears the active state in ${theme}`, async () => {
      const ui = render(
        <div className="bg-card p-2">
          <CombinatorToggle value="AND" onChange={() => {}} />
          <SettingsChoice id="units" label="Units" value="metric" options={[{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }]} onChange={() => {}} />
        </div>,
      );
      const p = await paint(theme, ui.innerHTML, {
        ...REFS, and: 'button[aria-pressed="true"]', or: 'button[aria-pressed="false"]', checked: 'label:has(input:checked)',
      });
      assertActiveNotPrimary('and', p, theme);
      assertActiveNotPrimary('checked', p, theme);
      assert.notEqual(p.and.background, p.or.background, `selected and resting options in ${theme} paint different faces`);
      assertClears('resting option label', ratio(p.or.ink, p.or.surface), AA_TEXT, theme);
    });

    it(`a selected tab keeps the active state over the theme's tab reset in ${theme}`, async () => {
      const ui = render(
        <div className="bg-card p-2">
          <Tabs value="ids">
            <TabsList className="bg-transparent">
              <TabsTrigger value="ids" className={ACTIVE_TAB_CLASS}>IDS</TabsTrigger>
              <TabsTrigger value="rules" className={ACTIVE_TAB_CLASS}>Rules</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>,
      );
      const p = await paint(theme, ui.innerHTML, { ...REFS, tab: '[role="tab"][data-state="active"]' });
      assertActiveNotPrimary('tab', p, theme);
    });

    for (const [passRate, role] of [[100, 'ok'], [60, 'warn'], [10, 'danger']] as const) {
      it(`a ${role} pass-rate bar paints the ${role} solid fill in ${theme}`, async () => {
        const ui = render(<div className="bg-card p-2"><PassRateBar passRate={passRate} /></div>);
        const p = await paint(theme, ui.innerHTML, { ...REFS, bar: '[style*="width"]' });
        assert.equal(p.bar.background, p[`ref-${role}`].background, `pass-rate bar in ${theme} paints bg-${role}-solid`);
      });
    }

    it(`every solid status fill clears 3:1 on panel, raised and input surfaces and carries AA ink in ${theme}`, async () => {
      const wells = ['bg-card', 'bg-muted', 'bg-input'] as const;
      const html = wells.map((well) => `<div class="${well} p-2">${ROLES.map((role) =>
        `<span data-well="${well}" data-role="${role}" class="bg-${role}-solid text-solid-foreground px-1">9</span>`).join('')}</div>`).join('');
      const selectors: Record<string, string> = {};
      for (const well of wells) for (const role of ROLES) {
        selectors[`${well}:${role}`] = `[data-well="${well}"][data-role="${role}"]`;
        selectors[`${well}:${role}:behind`] = `.${well}`;
      }
      const p = await paint(theme, `<div class="bg-card">${html}</div>`, selectors);
      for (const well of wells) for (const role of ROLES) {
        const fill = p[`${well}:${role}`];
        assert.notEqual(fill.background, 'rgba(0, 0, 0, 0)', `bg-${role}-solid in ${theme} paints a fill`);
        assertClears(`${role} solid fill against ${well}`, ratio(fill.surface, p[`${well}:${role}:behind`].surface), AA_NON_TEXT, theme);
        assertClears(`solid-foreground on the ${role} fill`, ratio(fill.ink, fill.surface), AA_TEXT, theme);
      }
    });

    it(`a text link is neutral underlined ink that clears AA in ${theme}`, async () => {
      const p = await paint(theme, `<div class="bg-card p-2"><a id="link" href="#x" class="${TEXT_LINK_CLASS}">OpenStreetMap</a></div>`, { ...REFS, link: '#link' });
      assert.match(p.link.underline, /underline/, `link in ${theme} stays underlined`);
      assert.equal(p.link.color, p.refPlain.color, `link in ${theme} paints the plain foreground ink, no hue`);
      assertClears('link', ratio(p.link.ink, p.link.surface), AA_TEXT, theme);
    });

    // #8802 R5 review: a caption over a bright thumbnail (a white wall close-up)
    // must keep AA, so the scrim is measured over pure white.
    it(`presentation caption text clears AA on its scrim over a white thumbnail in ${theme}`, async () => {
      const noop = () => {};
      const ui = render(
        <div style={{ background: 'rgb(255, 255, 255)' }}>
          <PresentationViewCard view={{ id: 'v1', name: 'North wall', entityRefs: [], thumbnailDataUrl: null } as never}
            isActive={false} isEditing={false} editingName="" onSelect={noop} onStartRename={noop} onCommitRename={noop}
            onCancelRename={noop} onEditingNameChange={noop} onSetTransition={noop} onDelete={noop} />
        </div>,
      );
      const p = await paint(theme, ui.innerHTML, { ...REFS, name: '.text-xs.font-medium', count: '.font-medium + .text-2xs' });
      assertClears('view name on the caption scrim', ratio(p.name.ink, p.name.surface), AA_TEXT, theme);
      assertClears('object count on the caption scrim', ratio(p.count.ink, p.count.surface), AA_TEXT, theme);
    });

    // #8802 R5 review: the picked pin follows the tiles actually showing, not the
    // theme ("Toggle style" puts light tiles under dark and dark under light).
    for (const [tiles, tile, dark] of [['light', 'rgb(250, 250, 248)', false], ['dark', 'rgb(14, 14, 14)', true]] as const) {
      it(`map pins clear 3:1 on ${tiles} tiles, and the picked pin carries an opposite-ink outline, in ${theme}`, async () => {
        const halo = Object.values(mapInkStyle(dark))[0] as string;
        const html = `<div style="background: ${tile}"><div id="map" class="${mapInkClass(dark)}" style="--map-pin-halo: ${halo}">${pickedPinElement().outerHTML}</div></div>`;
        const read = await withThemedPage(theme, html, (page) => page.evaluate(() => {
          const path = document.querySelector('[data-map-pin] path')!;
          const s = getComputedStyle(path);
          return { origin: getComputedStyle(document.getElementById('map')!).color, fill: s.fill, stroke: s.stroke };
        }));
        const c = (css: string) => { const { r, g, b } = parseRgba(css); return [r, g, b]; };
        const t = c(tile);
        assertClears(`origin pin on ${tiles} tiles`, ratio(c(read.origin), t), AA_NON_TEXT, theme);
        assertClears(`picked pin on ${tiles} tiles`, ratio(c(read.fill), t), AA_NON_TEXT, theme);
        assertClears(`picked pin outline against its fill on ${tiles} tiles`, ratio(c(read.stroke), c(read.fill)), AA_NON_TEXT, theme);
      });
    }
  }
});
