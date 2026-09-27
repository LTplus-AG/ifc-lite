/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Target size (WCAG 2.2 2.5.8) and focus visibility (2.4.7) acceptance for
 * #5826: a charter runtime measurement found 46 of 82 visible buttons on
 * the main screen under 24x24 CSS px, and the welcome card's primary
 * button showed no focus ring on Tab.
 *
 * The empty-screen half runs unconditionally (no model fixture needed —
 * this is exactly the "46 of 82" screen the issue measured). The
 * loaded-model half additionally covers post-load-only buttons; it needs
 * `tests/models/ara3d/AC20-FZK-Haus.ifc` (`pnpm fixtures`) and skips with a
 * pointer to that command when absent, per this suite's existing
 * convention (see viewport-hud.e2e.spec.ts).
 */

import { test, expect, type Page, type Locator } from '@playwright/test';
import { existsSync } from 'fs';
import { join } from 'path';

const STORE = '__ifc_lite_viewer_store__';
const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const MIN_TARGET_PX = 24;

interface UndersizedButton {
  text: string;
  ariaLabel: string | null;
  width: number;
  height: number;
}

/**
 * Every visible, enabled `<button>` and `[role="button"]` whose EFFECTIVE
 * hit area is under 24x24 CSS px. Elements with zero area (display:none,
 * detached, or a 0x0 layout box, e.g. an icon slot with no children) are
 * excluded — they are not a rendered target a pointer could under-hit,
 * they are absent.
 *
 * "Effective" matters: WCAG 2.2 2.5.8's own Understanding doc sanctions
 * growing a target's HIT area via an invisible `::after` pseudo-element
 * (absolutely positioned, pulled outward with a negative inset) without
 * enlarging the visible control — exactly the technique `buttonVariants`
 * uses (#5826). A click landing in that pseudo-element's box still
 * dispatches to the real element (pseudo-elements have no DOM identity of
 * their own), so it is a real target, but `getBoundingClientRect` on the
 * host element alone would miss it. So this reads the `::after`'s computed
 * box too and unions it with the element's own rect before comparing.
 */
async function findUndersizedButtons(page: Page): Promise<UndersizedButton[]> {
  return page.evaluate((min) => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
    const out: UndersizedButton[] = [];
    for (const el of nodes) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if ((el as HTMLButtonElement).disabled) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // not rendered, not a target

      let { width, height } = rect;
      const after = getComputedStyle(el, '::after');
      if (after.content !== 'none' && after.position === 'absolute') {
        const outward = (v: string) => Math.max(0, -parseFloat(v) || 0);
        width += outward(after.left) + outward(after.right);
        height += outward(after.top) + outward(after.bottom);
      }

      if (width < min || height < min) {
        out.push({
          text: el.textContent?.trim().slice(0, 40) ?? '',
          ariaLabel: el.getAttribute('aria-label'),
          width,
          height,
        });
      }
    }
    return out;
  }, MIN_TARGET_PX);
}

/** Non-transparent, non-`none` focus indicator: an outline or a ring
 *  (`box-shadow`, how every `buttonVariants` focus-visible ring renders). */
async function hasVisibleFocusIndicator(locator: Locator): Promise<{ ok: boolean; outline: string; outlineColor: string; boxShadow: string }> {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    const outlineVisible = s.outlineStyle !== 'none' && s.outlineWidth !== '0px' && s.outlineColor !== 'transparent' && s.outlineColor !== 'rgba(0, 0, 0, 0)';
    const boxShadowVisible = s.boxShadow !== 'none' && s.boxShadow.trim() !== '';
    return {
      ok: outlineVisible || boxShadowVisible,
      outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
      outlineColor: s.outlineColor,
      boxShadow: s.boxShadow,
    };
  });
}

test.describe('#5826 target size and focus visibility', () => {
  test('empty start screen: no visible button is under 24x24 CSS px', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction((key) => !!(globalThis as Record<string, unknown>)[key], STORE);
    await page.waitForSelector('button', { state: 'visible' });

    const undersized = await findUndersizedButtons(page);
    expect(
      undersized,
      `${undersized.length} button(s) under 24x24 CSS px:\n${undersized.map((b) => `  ${b.width.toFixed(1)}x${b.height.toFixed(1)} "${b.ariaLabel ?? b.text}"`).join('\n')}`,
    ).toEqual([]);
  });

  test('empty start screen: Tab onto the welcome primary button shows a visible focus indicator', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction((key) => !!(globalThis as Record<string, unknown>)[key], STORE);

    // The first button inside the welcome card is its demo-project action.
    // It starts disabled until the WebGPU probe resolves.
    const target = page.locator('[data-tour="empty-state-card"] button').first();

    await target.waitFor({ state: 'visible' });
    await expect(target).toBeEnabled({ timeout: 15000 });
    for (let i = 0; i < 150 && !(await target.evaluate((el) => document.activeElement === el)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();

    const focus = await hasVisibleFocusIndicator(target);
    expect(focus.ok, `no visible outline or ring on Tab focus (outline: ${focus.outline}, box-shadow: ${focus.boxShadow})`).toBe(true);
  });

  test('loaded model: no visible button is under 24x24 CSS px', async ({ page }) => {
    test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);

    await page.goto('/');
    await page.waitForFunction((key) => !!(globalThis as Record<string, unknown>)[key], STORE);
    await page.locator('input[type="file"]').first().setInputFiles(join(process.cwd(), FIXTURE));
    // Same store-driven readiness signal the HUD collision suite uses:
    // wait for at least one model to register, then let the toolbar/panel
    // chrome that only renders once a model is loaded settle.
    await page.waitForFunction((key) => {
      const store = (globalThis as Record<string, unknown>)[key] as
        | { getState: () => { models: Map<unknown, unknown> } }
        | undefined;
      return !!store && store.getState().models.size > 0;
    }, STORE, { timeout: 120000 });
    await page.waitForTimeout(2000);

    const undersized = await findUndersizedButtons(page);
    expect(
      undersized,
      `${undersized.length} button(s) under 24x24 CSS px:\n${undersized.map((b) => `  ${b.width.toFixed(1)}x${b.height.toFixed(1)} "${b.ariaLabel ?? b.text}"`).join('\n')}`,
    ).toEqual([]);
  });
});
