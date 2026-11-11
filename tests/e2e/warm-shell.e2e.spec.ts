/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer shell is mounted before the first file arrives (fixed load
 * floor, warm-shell.ts). Before this change the first open swapped the
 * welcome screen for the viewer, so the open itself mounted `Viewport` and
 * created the WebGPU device and pipelines. These checks pin the new order:
 *   - with idle time before the open, the renderer exists before the file
 *     input fires, under an inert, hidden shell;
 *   - the first open reuses that canvas: no unmount/mount between the
 *     welcome screen and the loaded model;
 *   - `perf.warmShell=0` restores the previous behaviour exactly.
 * Uses the committed `hello-wall.ifc` sample, so it never skips.
 */

import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { checkAxeBaseline } from './axe-baseline';
import { GPU_STRICT, skipForGpuDeviceLoss } from './gpu-device-loss';

const SAMPLE = join(process.cwd(), 'apps/viewer/public/samples/hello-wall.ifc');
const STORE_KEY = '__ifc_lite_viewer_store__';

async function openSample(page: Page): Promise<void> {
  await page.locator('#file-input-open').setInputFiles(SAMPLE);
  await page.waitForFunction((key) => {
    const s = (globalThis as Record<string, { getState(): { loading: boolean; models: Map<string, { loadState?: string }> } } | undefined>)[key]?.getState();
    return !!s && !s.loading && s.models.size === 1 && [...s.models.values()].every((m) => m.loadState === 'complete');
  }, STORE_KEY, { timeout: 120_000 });
}

/** Wait until the viewer reports its idle boot work finished (warm shell ready, or refused). */
async function bootSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => (globalThis as { __ifc_lite_boot_settled__?: () => boolean }).__ifc_lite_boot_settled__?.() === true, null, { timeout: 30_000 });
}

/** The canvases inside the viewport, each tagged with whether it sits in the viewer shell. */
function viewportCanvases(page: Page): Promise<Array<{ inShell: string | null; probe: string | null }>> {
  return page.evaluate(() => [...document.querySelectorAll('[data-viewport] canvas')].map((c) => ({
    inShell: c.closest('[data-viewer-shell]')?.getAttribute('data-viewer-shell') ?? null,
    probe: (c as HTMLElement).dataset.warmShellProbe ?? null,
  })));
}

test.describe('warm viewer shell', () => {
  test('the renderer exists before the first open, and the open keeps its canvas', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await page.goto('/');
    // Idle time before the open: the shell mounts under the welcome layer.
    const shell = page.locator('[data-viewer-shell="warm"]');
    await expect(shell).toHaveCount(1, { timeout: 30_000 });
    await page.waitForFunction(() => typeof (globalThis as { __ifc_lite_render_stats__?: unknown }).__ifc_lite_render_stats__ === 'function', null, { timeout: 30_000 });
    const before = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-viewer-shell="warm"]');
      const canvas = el?.querySelector<HTMLCanvasElement>('canvas');
      if (canvas) canvas.dataset.warmShellProbe = 'boot';
      return { inert: el?.inert ?? null, visibility: canvas ? getComputedStyle(canvas).visibility : null, hasCanvas: !!canvas };
    });
    expect(before).toEqual({ inert: true, visibility: 'hidden', hasCanvas: true });
    // The welcome screen is still what the user sees and can use.
    await expect(page.getByRole('button', { name: /open/i }).first()).toBeVisible();

    await openSample(page);
    const after = await viewportCanvases(page);
    // The canvas the renderer was created on at boot is the one showing the model.
    expect(after.filter((c) => c.inShell === 'active')).toContainEqual({ inShell: 'active', probe: 'boot' });
    await expect(page.locator('[data-viewer-shell="warm"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('perf.warmShell=0 keeps the shell unmounted until the first open', async ({ page }) => {
    await page.goto('/?perf.warmShell=0');
    await expect(page.locator('#file-input-open')).toBeAttached();
    // Idle well past the warm-up's schedule (idle callback, 4 s timeout).
    await page.waitForTimeout(6000);
    await expect(page.locator('[data-viewer-shell]')).toHaveCount(0);
    expect(await page.evaluate(() => typeof (globalThis as { __ifc_lite_render_stats__?: unknown }).__ifc_lite_render_stats__)).toBe('undefined');
    await openSample(page);
    await expect(page.locator('[data-viewer-shell="active"]')).toHaveCount(1);
  });

  test('the welcome screen keeps its keyboard order and accessibility with the shell underneath', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-viewer-shell="warm"]')).toHaveCount(1, { timeout: 30_000 });
    await bootSettled(page);
    // Walk the whole tab order: no stop may land inside the hidden shell.
    const stops: Array<{ inShell: boolean; tag: string }> = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => {
        const el = document.activeElement;
        return { inShell: !!el?.closest('[data-viewer-shell="warm"]'), tag: el?.tagName ?? 'none' };
      }));
    }
    expect(stops.filter((s) => s.inShell)).toEqual([]);
    expect(stops.some((s) => s.tag !== 'BODY' && s.tag !== 'none')).toBe(true);
    // Nothing in the shell is focusable or exposed while it is inert and hidden.
    const exposed = await page.evaluate(() => {
      const shell = document.querySelector('[data-viewer-shell="warm"]');
      if (!shell) return -1;
      return [...shell.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
        .filter((el) => { el.focus(); return document.activeElement === el; }).length;
    });
    expect(exposed).toBe(0);
    // The same axe baseline as the plain welcome screen (viewer-smoke's 'empty' row).
    const axe = await checkAxeBaseline(page, 'empty');
    expect(axe.failure, axe.failure ?? '').toBeNull();
  });

  test('under 4 GB of reported device memory the shell waits for the first open', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 2 }));
    await page.goto('/');
    await bootSettled(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-viewer-shell]')).toHaveCount(0);
    await openSample(page);
    await expect(page.locator('[data-viewer-shell="active"]')).toHaveCount(1);
  });

  test('without WebGPU the welcome screen stands alone and boot still settles', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => undefined }));
    await page.goto('/');
    await bootSettled(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-viewer-shell]')).toHaveCount(0);
  });

  test('a device lost before the first open does not break that open', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    // The warm shell's first device is destroyed shortly after creation; later devices (recovery) are left alone.
    await page.addInitScript(() => {
      const adapter = (globalThis as { GPUAdapter?: { prototype: { requestDevice(...a: unknown[]): Promise<{ destroy(): void }> } } }).GPUAdapter;
      if (!adapter) return;
      const original = adapter.prototype.requestDevice;
      let first = true;
      adapter.prototype.requestDevice = async function (this: unknown, ...args: unknown[]) {
        const device = await original.apply(this, args);
        if (first) { first = false; setTimeout(() => device.destroy(), 500); }
        return device;
      };
    });
    await page.goto('/');
    await expect(page.locator('[data-viewer-shell="warm"]')).toHaveCount(1, { timeout: 30_000 });
    await page.waitForTimeout(2000);
    try {
      await openSample(page);
    } catch (err) {
      if (!GPU_STRICT) skipForGpuDeviceLoss('the open after a pre-load device loss', String(err).slice(0, 200));
      throw err;
    }
    await expect(page.locator('[data-viewer-shell="active"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
});
