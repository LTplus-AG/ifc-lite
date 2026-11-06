/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The #8802 R4 state language, measured on the mounted primitives.
 *
 * Each case mounts a real primitive in its primary or active state (happy-dom),
 * then paints that DOM in real Chrome with the compiled app stylesheet and
 * checks two things:
 *
 * 1. the state colour is applied: the element paints the same colour as a
 *    reference element carrying the state token utility, and a different
 *    colour from its own resting sibling. Without the tokens (`bg-active-surface`,
 *    `text-active`, ...) the utilities do not exist, so this fails rather than
 *    letting an unstyled element pass the contrast check on inherited ink;
 * 2. the state clears WCAG AA where it is painted: 4.5:1 for its text, 3:1
 *    for its non-text indicators (the solid primary fill against the panel,
 *    the palette row's active bar, the drawing check mark's fill).
 *
 * Surfaces are composited the way Chrome paints them: every ancestor's
 * background, translucent tints included, over white. A layer drawing the
 * HUD's active overlay (`active-overlay`, a background image) is composited
 * with the active surface colour on top of its own fill.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { HudChip } from '@/components/viewport-ui/hud/HudChip';
import { RegisteredPaletteOption } from '@/components/viewer/command-palette-option';
import { resolveEnglish } from '@/i18n/registry.js';
import { cleanup, render } from '@/test/render.js';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage, type Theme } from './render-harness.js';
import { contrastRatio } from './wcag.js';

const THEMES: readonly Theme[] = ['light', 'dark', 'colorful'];
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

before(warmContrastBrowser);
afterEach(cleanup);
after(closeContrastBrowser);

/** Reference swatches: what each state token paints in the theme under test. */
const REFERENCES = `
  <div id="ref-plain">ref</div>
  <div id="ref-active" class="text-active border-l-2 border-active">ref</div>
  <div id="ref-active-surface" class="bg-active-surface">ref</div>
  <div id="ref-primary" class="bg-primary text-primary-foreground">ref</div>
`;

interface Painted {
  /** Computed values, for "is the state colour applied" comparisons. */
  color: string;
  background: string;
  backgroundImage: string;
  borderLeft: string;
  /** The `::before` fill (the palette row's focus bar is a pseudo-element). */
  before: string;
  /** Opaque composited colours, [r, g, b]. */
  surface: number[];
  ink: number[];
  /** The composited surface behind the element (its parent's paint). */
  behind: number[];
  /** The `::before` bar composited over the surface behind the element. */
  bar: number[];
}

/** Paints `bodyHtml` (plus the reference swatches) and reads `selectors`. */
async function paint(theme: Theme, bodyHtml: string, selectors: Record<string, string>): Promise<Record<string, Painted>> {
  return withThemedPage(theme, `${bodyHtml}${REFERENCES}`, async (page) => {
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    // tsx's esbuild `keepNames` wraps the named helpers below in `__name()`,
    // which the page lacks; give the page the identity version (a string, so
    // esbuild leaves it alone).
    await page.evaluate('globalThis.__name = (fn) => fn;');
    return page.evaluate((wanted) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const overlay = getComputedStyle(document.getElementById('ref-active-surface')!).backgroundColor;
      const read = () => Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
      const surfaceOf = (el: Element | null) => {
        const layers: Element[] = [];
        for (let a = el; a; a = a.parentElement) layers.unshift(a);
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgb(255, 255, 255)';
        ctx.fillRect(0, 0, 1, 1);
        for (const layer of layers) {
          const style = getComputedStyle(layer);
          ctx.fillStyle = style.backgroundColor;
          ctx.fillRect(0, 0, 1, 1);
          if (style.backgroundImage !== 'none') {
            ctx.fillStyle = overlay;
            ctx.fillRect(0, 0, 1, 1);
          }
        }
        return read();
      };
      const over = (color: string, base: number[]) => {
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgb(${base[0]}, ${base[1]}, ${base[2]})`;
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return read();
      };
      const out: Record<string, unknown> = {};
      for (const [name, selector] of Object.entries(wanted)) {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`no element for ${name} (${selector})`);
        const style = getComputedStyle(el);
        const before = getComputedStyle(el, '::before').backgroundColor;
        const surface = surfaceOf(el);
        out[name] = {
          color: style.color,
          background: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          borderLeft: style.borderLeftColor,
          before,
          surface,
          ink: over(style.color, surface),
          behind: surfaceOf(el.parentElement),
          bar: over(before, surfaceOf(el.parentElement)),
        };
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

/** The state tokens exist: the active ink is not the plain inherited ink and
 *  the active surface is not transparent. Without this an undefined token
 *  makes element and reference both inherit, and "equal" passes vacuously. */
function assertTokensPaint(painted: Record<string, Painted>, theme: Theme) {
  assert.notEqual(painted.refActive.color, painted.refPlain.color, `text-active in ${theme} paints its own ink`);
  assert.notEqual(painted.refActiveSurface.background, 'rgba(0, 0, 0, 0)', `bg-active-surface in ${theme} paints a surface`);
}

/** The element paints the active state: the reference ink and surface. */
function assertActive(name: string, painted: Record<string, Painted>, theme: Theme) {
  assertTokensPaint(painted, theme);
  const el = painted[name];
  assert.equal(el.color, painted.refActive.color, `${name} in ${theme} paints the active ink`);
  assert.equal(el.background, painted.refActiveSurface.background, `${name} in ${theme} paints the active surface`);
}

const SELECT_REFS = { refPlain: '#ref-plain', refActive: '#ref-active', refActiveSurface: '#ref-active-surface', refPrimary: '#ref-primary' };

describe('state language: primary, pressed, active and filtered states (Refs 8802, R4)', () => {
  for (const theme of THEMES) {
    it(`a primary button is a solid primary fill whose label clears AA in ${theme}`, async () => {
      const ui = render(<div className="bg-background p-2"><Button data-test="primary">New topic</Button></div>);
      const p = await paint(theme, ui.innerHTML, { ...SELECT_REFS, button: '[data-test="primary"]' });
      assert.equal(p.button.background, p.refPrimary.background, `primary button in ${theme} paints bg-primary`);
      assert.equal(p.button.color, p.refPrimary.color, `primary button in ${theme} paints text-primary-foreground`);
      assertClears('primary label on its fill', ratio(p.button.ink, p.button.surface), AA_TEXT, theme);
      // The fill must read as a button, not a disabled tint (the council's
      // "looks disabled" defect). Colorful keeps its pre-R4 purple accent,
      // which sits on translucent glass, so the fill check covers light/dark.
      if (theme !== 'colorful') {
        assertClears('primary fill against the panel', ratio(p.button.surface, p.button.behind), AA_NON_TEXT, theme);
      }
    });

    it(`a pressed toggle and a checked radio wear the active state on a raised track in ${theme}`, async () => {
      const ui = render(
        <div className="bg-background p-2">
          <div className="flex bg-muted p-0.5">
            <Button variant="toggle" size="sm" aria-pressed={true} data-test="pressed">By class</Button>
            <Button variant="toggle" size="sm" aria-pressed={false} data-test="resting">Spatial</Button>
            {/* Mirrors the drawing toolbar's markup tool segment, a radio-role button. */}
            {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
            <Button variant="toggle" size="sm" role="radio" aria-checked={true} data-test="checked">Select</Button>
          </div>
        </div>,
      );
      const p = await paint(theme, ui.innerHTML, {
        ...SELECT_REFS, pressed: '[data-test="pressed"]', resting: '[data-test="resting"]', checked: '[data-test="checked"]',
      });
      assertActive('pressed', p, theme);
      assertActive('checked', p, theme);
      assert.notEqual(p.pressed.color, p.resting.color, `pressed and resting toggles in ${theme} paint different ink`);
      assert.notEqual(p.pressed.background, p.resting.background, `pressed and resting toggles in ${theme} paint different faces`);
      assertClears('pressed toggle label', ratio(p.pressed.ink, p.pressed.surface), AA_TEXT, theme);
      assertClears('checked radio label', ratio(p.checked.ink, p.checked.surface), AA_TEXT, theme);
      assertClears('resting toggle label', ratio(p.resting.ink, p.resting.surface), AA_TEXT, theme);
    });

    it(`the selected segment wears the active state in ${theme}`, async () => {
      const ui = render(
        <div className="bg-background p-2">
          <SegmentedControl label="Units" value="m" onValueChange={() => {}}
            options={[{ value: 'm', label: 'Metres' }, { value: 'ft', label: 'Feet' }]} />
        </div>,
      );
      // React sets `checked` as a property; serialise it so Chrome sees the state.
      for (const input of ui.querySelectorAll('input')) if (input.checked) input.setAttribute('checked', '');
      const p = await paint(theme, ui.innerHTML, {
        ...SELECT_REFS, on: 'input:checked + span', off: 'input:not(:checked) + span',
      });
      assertActive('on', p, theme);
      assert.notEqual(p.on.color, p.off.color, `selected and resting segments in ${theme} paint different ink`);
      assertClears('selected segment label', ratio(p.on.ink, p.on.surface), AA_TEXT, theme);
    });

    it(`an active filter chip reads as on, not as inert text, in ${theme}`, async () => {
      const ui = render(
        <div className="bg-background">
          <div className="bg-muted/50 px-2 py-1.5"><FilterChip onClear={() => {}} clearLabel="Clear type filter">IfcWall</FilterChip></div>
        </div>,
      );
      const p = await paint(theme, ui.innerHTML, { ...SELECT_REFS, chip: '[data-filter-chip]', clear: '[data-filter-chip] button' });
      assertActive('chip', p, theme);
      assertClears('filter chip label', ratio(p.chip.ink, p.chip.surface), AA_TEXT, theme);
      assertClears('filter chip clear glyph', ratio(p.clear.ink, p.clear.surface), AA_TEXT, theme);
    });

    it(`an active HUD chip (isolation) keeps its surface and wears the active state in ${theme}`, async () => {
      const ui = render(
        <div className="bg-canvas p-4">
          <HudChip active dismiss={{ onClick: () => {}, 'aria-label': 'Clear', icon: <span>x</span> }}>Isolated elements · 4</HudChip>
          <HudChip>Hidden elements · 2</HudChip>
        </div>,
      );
      const p = await paint(theme, ui.innerHTML, {
        ...SELECT_REFS, chip: '[data-active]', label: '[data-active] > span', neutral: 'div:not([data-active]) > span.truncate',
        neutralChip: 'div:not([data-active]):has(> span.truncate)',
      });
      // The overlay is layered on the HUD surface; it must not replace it.
      assert.equal(p.chip.background, p.neutralChip.background, `active HUD chip in ${theme} keeps the HUD surface fill`);
      assertTokensPaint(p, theme);
      assert.equal(p.label.color, p.refActive.color, `active HUD chip label in ${theme} paints the active ink`);
      assert.notEqual(p.chip.backgroundImage, 'none', `active HUD chip in ${theme} layers the active overlay`);
      assert.notEqual(p.label.color, p.neutral.color, `active and neutral HUD chips in ${theme} paint different ink`);
      assertClears('active HUD chip label', ratio(p.label.ink, p.label.surface), AA_TEXT, theme);
    });

    it(`the focused palette row is tinted with an active bar, and the match is highlighted, in ${theme}`, async () => {
      const label = resolveEnglish('commandPalette.view.frame.label');
      const query = label.slice(0, 3);
      const placement = { index: 0, query, onActivate: () => {}, onHover: () => {} };
      const ui = render(
        <div className="bg-popover text-popover-foreground">
          <RegisteredPaletteOption commandId="view:frame" selected {...placement} />
          <RegisteredPaletteOption commandId="view:home" selected={false} {...placement} index={1} query="hom" />
        </div>,
      );
      const p = await paint(theme, ui.innerHTML, {
        ...SELECT_REFS,
        row: '[data-command-id="view:frame"]',
        match: '[data-command-id="view:frame"] mark',
        rest: '[data-command-id="view:frame"] span.truncate',
        idleMatch: '[data-command-id="view:home"] mark',
      });
      assertTokensPaint(p, theme);
      assert.equal(p.row.background, p.refActiveSurface.background, `focused row in ${theme} paints the active surface`);
      assert.equal(p.row.before, p.refActive.borderLeft, `focused row's leading bar in ${theme} paints the active ink`);
      assert.equal(p.match.color, p.refActive.color, `matched text in ${theme} paints the active ink`);
      assertClears('focused row active bar', ratio(p.row.bar, p.row.behind), AA_NON_TEXT, theme);
      assertClears('matched text on the focused row', ratio(p.match.ink, p.match.surface), AA_TEXT, theme);
      assertClears('row label on the focused row', ratio(p.rest.ink, p.rest.surface), AA_TEXT, theme);
      assertClears('matched text on a resting row', ratio(p.idleMatch.ink, p.idleMatch.surface), AA_TEXT, theme);
    });
  }
});
