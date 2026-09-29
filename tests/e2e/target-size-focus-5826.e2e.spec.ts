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
const NO_GEOREF_FIXTURE = 'apps/landing/samples/hello-wall.ifc';
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

  test('privacy toast action and dismiss targets are at least 24x24 CSS px (#6333)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction((key) => !!(globalThis as Record<string, unknown>)[key], STORE);
    await expect(page.getByRole('button', { name: 'Privacy settings' })).toBeVisible({ timeout: 15000 });
    const privacyToast = page.locator('[data-toast-seq]').filter({
      has: page.getByRole('button', { name: 'Privacy settings' }),
    });
    await expect(privacyToast.getByRole('button', { name: 'Dismiss notification' })).toBeVisible();

    const undersized = (await findUndersizedButtons(page)).filter((button) =>
      button.text === 'Privacy settings' || button.ariaLabel === 'Dismiss notification');
    expect(undersized, `undersized privacy toast targets: ${JSON.stringify(undersized)}`).toEqual([]);
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

  test('loaded sidebar Split and Collapse chrome have 24px targets and keep their actions (#6340)', async ({ page }) => {
    await page.goto('/?model=/samples/building-architecture.ifc');
    await page.waitForFunction((key) => {
      const store = (globalThis as Record<string, unknown>)[key] as
        | { getState: () => { models: Map<unknown, { ifcDataStore?: unknown }>; loading: boolean; geometryStreamingActive: boolean } }
        | undefined;
      const state = store?.getState();
      return !!state && state.models.size === 1 && !state.loading && !state.geometryStreamingActive
        && [...state.models.values()][0].ifcDataStore != null;
    }, STORE, { timeout: 120000 });

    const split = page.getByRole('button', { name: 'Split panel', exact: true }).first();
    const collapse = page.getByRole('button', { name: 'Collapse sidebar to icons', exact: true }).first();
    for (const button of [split, collapse]) {
      await expect(button).toBeVisible();
      const rect = await button.boundingBox();
      expect(rect, 'the sidebar button has a rendered hit target').not.toBeNull();
      expect(Math.min(rect!.width, rect!.height), 'sidebar chrome hit target is at least 24px').toBeGreaterThanOrEqual(MIN_TARGET_PX);
    }

    await split.click();
    await expect(page.getByRole('menuitem').first()).toBeVisible();
    await page.getByRole('menuitem').first().click();
    await expect.poll(() => page.evaluate((key) => {
      const store = (globalThis as Record<string, unknown>)[key] as
        { getState: () => { sidebarSecondaryPanel: string | null } };
      return store.getState().sidebarSecondaryPanel;
    }, STORE)).not.toBeNull();

    await collapse.click();
    await expect.poll(() => page.evaluate((key) => {
      const store = (globalThis as Record<string, unknown>)[key] as
        { getState: () => { sidebarMode: string } };
      return store.getState().sidebarMode;
    }, STORE)).toBe('collapsed');
  });

  test('authored model without georeferencing: Add Georeferencing target is at least 24x24 CSS px', async ({ page }) => {
    // #5826 follow-up: the committed Bonsai IFC has no georeference. AC20
    // does, so its settled metadata card cannot expose the Add control.
    await page.goto('/');
    await page.waitForFunction((key) => !!(globalThis as Record<string, unknown>)[key], STORE);
    await page.locator('input[type="file"]').first().setInputFiles(join(process.cwd(), NO_GEOREF_FIXTURE));
    await page.waitForFunction((key) => {
      const store = (globalThis as Record<string, unknown>)[key] as
        | { getState: () => { models: Map<unknown, { ifcDataStore?: unknown }>; loading: boolean; geometryStreamingActive: boolean } }
        | undefined;
      const state = store?.getState();
      return !!state && state.models.size === 1 && !state.loading && !state.geometryStreamingActive
        && [...state.models.values()][0].ifcDataStore != null;
    }, STORE, { timeout: 120000 });

    const addGeoreferencing = page.getByRole('button', { name: 'Add Georeferencing', exact: true });
    await expect(addGeoreferencing).toBeVisible();
    await expect.poll(() => addGeoreferencing.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return Math.min(rect.width, rect.height);
    }).catch(() => 0)).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  });
});
