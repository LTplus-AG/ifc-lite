/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8947 R1: bounded real destinations; run alongside the unchanged #8946 UX suite. */
import { chromium, expect, test as base, type Download, type Page } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';
import type { RenderVisibilitySnapshot, SceneOwnerSnapshot } from '../../apps/viewer/src/lib/viewport-debug-hooks';

// Same read-only production diagnostics as visibility-scenarios and ortho-depth-nudge.
declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}
const test = base.extend({
  browser: async ({ launchOptions, headless, channel }, use) => {
    const attached = process.env.IFC_GPU_CDP_URL
      ? await chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL)
      : await chromium.launch({ ...launchOptions, headless, channel });
    try { await use(attached); } finally { await attached.close(); }
  },
});
const contexts = [
  { name: 'desktop-light', width: 1440, height: 900, theme: 'light' },
  { name: 'narrow-dark', width: 390, height: 844, theme: 'dark' },
] as const;
const errors = new WeakMap<Page, string[]>();
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette', exact: true });

async function start(page: Page, loaded = false, context: (typeof contexts)[number] = contexts[0]) {
  await page.setViewportSize({ width: context.width, height: context.height });
  await page.addInitScript(theme => {
    localStorage.setItem('ifc-lite-theme', theme);
    localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
    localStorage.setItem('ifc-lite:tours:v1', JSON.stringify({ inviteDismissedAt: '2026-01-01T00:00:00Z', tours: {} }));
  }, context.theme);
  await page.goto(loaded ? '/?lang=en&model=/samples/building-architecture.ifc' : '/?lang=en');
  await expect(page.getByRole('button', { name: /Commands…|More actions/ }).first()).toBeVisible();
  if (context.theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  if (loaded) await page.waitForFunction(() => {
    const s = globalThis.__ifc_lite_viewer_store__?.getState();
    return s?.models.size === 1 && !s.loading && !s.geometryStreamingActive &&
      [...s.models.values()].every(m => m.ifcDataStore && (m.geometryResult?.meshes.length ?? 0) > 0);
  }, undefined, { timeout: 180_000 });
}
async function find(page: Page, id: string, query: string) {
  if (!await palette(page).isVisible()) await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  const search = palette(page).getByRole('combobox');
  await search.fill(query);
  const row = palette(page).locator(`[data-command-id="${id}"]`);
  await expect(row).toBeVisible();
  return { row, search };
}
// #8947 R3: measure browser layout, including Tailwind-generated pseudo-elements.
async function assertStableLabels(page: Page, commandId: string, blocked: boolean) {
  const { row, search } = await find(page, commandId, 'hide');
  const options = palette(page).getByRole('option');
  const count = await options.count();
  expect(count, 'navigation needs an actual neighbour').toBeGreaterThan(1);
  for (let n = 0; n < count && await row.getAttribute('aria-selected') !== 'true'; n++) await search.press('ArrowDown');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  if (blocked) await expect(row).toHaveAttribute('aria-disabled', 'true');
  else await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  const measure = () => options.evaluateAll(elements => elements.map(element => {
    const label = element.querySelector<HTMLElement>('[data-command-label]')!;
    const rect = label.getBoundingClientRect();
    return { id: element.getAttribute('data-command-id'), x: rect.x,
      width: label.clientWidth, textWidth: label.scrollWidth };
  }));
  const before = await measure();
  const selected = before.findIndex(item => item.id === commandId);
  const next = (selected + 1) % count;
  expect(Math.abs(before[selected].x - before[next].x), 'selected and next labels align').toBeLessThan(0.5);
  await search.press('ArrowDown');
  await expect(options.nth(next)).toHaveAttribute('aria-selected', 'true');
  const after = await measure();
  for (const index of [selected, next]) {
    expect(Math.abs(after[index].x - before[index].x), 'ArrowDown never shifts a label').toBeLessThan(0.5);
  }
  await search.press('ArrowUp');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  const restored = await measure();
  expect(Math.abs(restored[selected].x - before[selected].x), 'ArrowUp never shifts a label').toBeLessThan(0.5);
  if ((page.viewportSize()?.width ?? 1440) <= 390) {
    for (const label of restored) {
      expect(label.width, `${label.id} has usable label width`).toBeGreaterThan(35);
      expect(label.textWidth, `${label.id} hide result fits without horizontal clipping`).toBeLessThanOrEqual(label.width);
    }
  }
}
async function run(page: Page, id: string, query: string) {
  const { row, search } = await find(page, id, query);
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  // Traverse the real active-descendant keyboard list, rather than click an action in evaluate.
  const count = await palette(page).getByRole('option').count();
  for (let n = 0; n < count && await row.getAttribute('aria-selected') !== 'true'; n++) {
    await search.press('ArrowDown');
  }
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await search.press('Enter');
  await expect(palette(page)).toBeHidden();
}
async function wall(page: Page) {
  return page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...s.models.values()][0];
    const ids = model.ifcDataStore!.entityIndex.byType;
    const expressId = (ids.get('IFCWALL') ?? ids.get('IFCWALLSTANDARDCASE'))?.[0];
    if (expressId === undefined) throw new Error('Bundled IFC has no wall');
    const id = s.toGlobalId(model.id, expressId);
    s.setSelectedEntityIds([id]); s.setSelectedEntityId(id);
    return id;
  });
}
const debug = (page: Page) => page.evaluate(() => {
  const host = globalThis as typeof globalThis & {
    __ifc_lite_view_projection__: () => number[];
    __ifc_lite_render_visibility__: () => RenderVisibilitySnapshot;
  };
  return { matrix: host.__ifc_lite_view_projection__(), visibility: host.__ifc_lite_render_visibility__() };
});

test.beforeEach(async ({ page }) => {
  const messages: string[] = []; errors.set(page, messages);
  page.on('pageerror', error => messages.push(error.message));
});
test.afterEach(async ({ page }, info) => {
  await info.attach('actual-state.png', { body: await page.screenshot(), contentType: 'image/png' });
  await info.attach('pageerrors.json', { body: JSON.stringify(errors.get(page)), contentType: 'application/json' });
  expect(errors.get(page), 'uncaught page errors (also saved on failure)').toEqual([]);
});

async function downloadBytes(file: Download): Promise<Buffer> {
  expect(await file.failure()).toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('palette saved federation opens both real pickers and reaches cancellable source review (#8947)', async ({ page }, info) => {
  await start(page, true);
  const downloaded = page.waitForEvent('download');
  await run(page, 'file:save-federation-setup', 'save federation setup');
  const saved = await downloaded;
  expect(saved.suggestedFilename()).toMatch(/\.federation\.json$/);
  const setupBytes = await downloadBytes(saved);
  await info.attach('saved-federation.json', { body: setupBytes, contentType: 'application/json' });
  const firstPicker = page.waitForEvent('filechooser');
  await run(page, 'file:open-federation-setup', 'open federation setup');
  const setupPicker = await firstPicker;
  expect(setupPicker.isMultiple()).toBe(false);
  const sourcePicker = page.waitForEvent('filechooser');
  await setupPicker.setFiles({ name: saved.suggestedFilename(), mimeType: 'application/json', buffer: setupBytes });
  const sources = await sourcePicker;
  expect(sources.isMultiple()).toBe(true);
  const source = await page.request.get('/samples/building-architecture.ifc');
  expect(source.ok()).toBe(true);
  await sources.setFiles({ name: 'building-architecture.ifc', mimeType: 'application/x-step', buffer: await source.body() });
  const review = page.getByRole('dialog', { name: 'Reopen federation setup', exact: true });
  await expect(review).toBeVisible();
  await expect(review.getByText('building-architecture.ifc', { exact: true })).toBeVisible();
  await expect(review.getByText('Matched', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Restore federation', exact: true })).toBeEnabled();
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(review).toBeHidden();
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().models.size)).toBe(1);
});

test('palette reset restores visibility while keeping selection and collection (#8947 C1242)', async ({ page }, info) => {
  await start(page, true);
  const id = await wall(page);
  await run(page, 'vis:set-iso', 'set collection');
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pinboardEntities.size)).toBe(1);
  await run(page, 'vis:hide', 'hide');
  await expect.poll(async () => (await debug(page)).visibility.hiddenIds.includes(id)).toBe(true);
  // Hide deliberately clears selection. Re-select the same parsed wall to test
  // preservation independently from the existing Hide-selection contract.
  expect(await wall(page)).toBe(id);
  const before = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return { scalar: s.selectedEntityId, ids: [...s.selectedEntityIds], collection: [...s.pinboardEntities] };
  });
  expect(before.ids).toEqual([id]);
  expect(before.collection).toHaveLength(1);
  const result = await find(page, 'vis:reset-filters', 'reset visibility filters');
  await expect(result.row).toContainText('Keep selection and collection');
  await expect(result.row).not.toHaveAttribute('aria-disabled', 'true');
  await info.attach('reset-preservation-command.png', { body: await page.screenshot(), contentType: 'image/png' });
  await run(page, 'vis:reset-filters', 'reset visibility filters');
  // This is a renderer visibility-input assertion; the installed-extension
  // journey separately proves actual hide/show raster changes.
  await expect.poll(async () => (await debug(page)).visibility.hiddenIds.includes(id)).toBe(false);
  expect(await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return { scalar: s.selectedEntityId, ids: [...s.selectedEntityIds], collection: [...s.pinboardEntities] };
  })).toEqual(before);
  const inactive = await find(page, 'vis:reset-filters', 'reset visibility filters');
  await expect(inactive.row).toHaveAttribute('aria-disabled', 'true');
  await expect(inactive.row).toContainText('No visibility filters to reset');
  await info.attach('reset-inactive-reason.png', { body: await page.screenshot(), contentType: 'image/png' });
  await inactive.search.fill('');
  await expect(palette(page).locator('[data-command-id="vis:reset-filters"]')).toHaveCount(0);
  await run(page, 'vis:show', 'show all');
  expect(await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return { scalar: s.selectedEntityId, ids: [...s.selectedEntityIds], collection: [...s.pinboardEntities] };
  })).toEqual({ scalar: null, ids: [], collection: [] });
});

test('palette Screenshot publishes a decoded nonblank PNG from the loaded real viewport (#8947)', async ({ page }, info) => {
  await start(page, true);
  const downloaded = page.waitForEvent('download');
  await run(page, 'export:screenshot', 'screenshot');
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/_screenshot\.png$/);
  const png = await downloadBytes(file);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  await info.attach('palette-screenshot.png', { body: png, contentType: 'image/png' });
  const pixels = await page.evaluate(async base64 => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const image = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('PNG inspection context unavailable');
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const colors = new Set<number>();
      for (let n = 0; n < data.length; n += 4) colors.add((data[n] << 16) | (data[n + 1] << 8) | data[n + 2]);
      return { width: image.width, height: image.height, colors: colors.size };
    } finally { image.close(); }
  }, png.toString('base64'));
  expect(pixels.width).toBeGreaterThan(300);
  expect(pixels.height).toBeGreaterThan(200);
  expect(pixels.colors, 'a real scene capture is not a solid blank image').toBeGreaterThan(16);
  await expect(page.getByText('Screenshot saved', { exact: true })).toBeVisible();
});

test('palette Presentation captures a real thumbnail and restores the saved camera through Play (#8947)', async ({ page }, info) => {
  await start(page, true);
  await wall(page);
  await run(page, 'panel:presentation', 'presentation');
  await page.getByRole('button', { name: 'Set collection from current context', exact: true }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pinboardEntities.size)).toBe(1);
  // Set an explicit camera before saving, so playback has a non-vacuous target.
  await run(page, 'view:orientation:front-top', 'front top');
  await expect.poll(async () => {
    const a = (await debug(page)).matrix;
    await page.waitForTimeout(100);
    const b = (await debug(page)).matrix;
    return a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  }).toBe(true);
  const savedMatrix = (await debug(page)).matrix;
  await page.getByRole('button', { name: 'Save current collection as presentation view', exact: true }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().basketViews.length)).toBe(1);
  const saved = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().basketViews[0]);
  expect(saved.viewpoint).not.toBeNull();
  expect(saved.thumbnailDataUrl).toMatch(/^data:image\/jpeg;base64,/);
  const thumbnail = page.getByRole('img', { name: saved.name, exact: true });
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.evaluate(element => {
    const img = element as HTMLImageElement;
    return img.complete && img.naturalWidth === 320 && img.naturalHeight === 180;
  })).toBe(true);
  expect(await thumbnail.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Thumbnail inspection context unavailable');
    context.drawImage(element as HTMLImageElement, 0, 0);
    const { data } = context.getImageData(0, 0, 320, 180);
    const colors = new Set<number>();
    for (let n = 0; n < data.length; n += 4) colors.add((data[n] << 16) | (data[n + 1] << 8) | data[n + 2]);
    return colors.size;
  }), 'saved thumbnail contains a nonblank rendered frame').toBeGreaterThan(16);
  await info.attach('presentation-thumbnail.jpg', { body: Buffer.from(saved.thumbnailDataUrl!.split(',')[1], 'base64'), contentType: 'image/jpeg' });
  await page.getByRole('button', { name: 'Clear active collection', exact: true }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pinboardEntities.size)).toBe(0);
  await run(page, 'view:orientation:back-right-bottom', 'back right bottom');
  await expect.poll(async () => (await debug(page)).matrix).not.toEqual(savedMatrix);
  // Loop keeps Stop available after the camera's finite transition completes.
  await page.getByRole('button', { name: 'Play all saved views (Shift+Click to loop)', exact: true }).click({ modifiers: ['Shift'] });
  try {
    await expect.poll(() => page.evaluate(() => {
      const s = globalThis.__ifc_lite_viewer_store__.getState();
      return { active: s.activeBasketViewId, refs: [...s.pinboardEntities] };
    })).toEqual({ active: saved.id, refs: saved.entityRefs });
    await expect.poll(async () => {
      const restored = (await debug(page)).matrix;
      return Math.max(...restored.map((v, i) => Math.abs(v - savedMatrix[i])));
    }, { message: 'real renderer returns to the saved camera', timeout: 15_000 }).toBeLessThan(1e-4);
    await info.attach('presentation-playback.png', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    await page.getByRole('button', { name: 'Stop playback', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Play all saved views (Shift+Click to loop)', exact: true })).toBeEnabled();
});

test('palette Plan refuses actual constrained and mobile widths while preserving the loaded 3D view (#8947)', async ({ page }, info) => {
  await start(page, true);
  await run(page, 'tool:wall', 'draw walls');
  await page.getByRole('button', { name: 'Leave the command', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 844 });
  await expect.poll(async () => {
    const width = Number(await page.locator('[data-model-split-width]').getAttribute('data-model-split-width'));
    return width > 0 && width < 800;
  }).toBe(true);
  let result = await find(page, 'model:plan', 'plan layout');
  await expect(result.row).toHaveAttribute('aria-disabled', 'true');
  await expect(result.row).toContainText('No room for the plan beside 3D');
  const before = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return { layout: s.modelLayout, ids: [...s.models.keys()] };
  });
  await result.row.click({ force: true });
  await expect(palette(page)).toBeVisible();
  await info.attach('plan-constrained-refusal.png', { body: await page.screenshot(), contentType: 'image/png' });
  await page.setViewportSize({ width: 390, height: 844 });
  result = await find(page, 'model:plan', 'plan layout');
  await expect(result.row).toHaveAttribute('aria-disabled', 'true');
  await expect(result.row).toContainText('Unavailable in this configuration');
  await result.row.click({ force: true });
  await expect(palette(page)).toBeVisible();
  await result.search.press('Escape');
  await expect(page.locator('canvas[data-viewport="main"]')).toBeVisible();
  expect(await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return { layout: s.modelLayout, ids: [...s.models.keys()] };
  })).toEqual(before);
  await expect(page.locator('[data-plan-view]')).toHaveCount(0);
});

for (const context of contexts) {
  test(`${context.name}: unloaded selection command explains refusal; Settings sections reach real controls (#8947)`, async ({ page }) => {
    await start(page, false, context);
    await assertStableLabels(page, 'vis:hide', true);
    const { row, search } = await find(page, 'vis:hide', 'Hide Selection');
    await expect(row).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/Select elements|Load a model/);
    await expect(row).toHaveAttribute('aria-describedby', /.+/);
    const recentBefore = await page.evaluate(() => localStorage.getItem('ifc-lite:cmd-palette:recent'));
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await search.press('Enter');
    await expect(palette(page)).toBeVisible();
    await expect(search).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('ifc-lite:cmd-palette:recent'))).toBe(recentBefore);
    await expect(palette(page).getByText('run', { exact: true })).toHaveCount(0);
    // A real pointer click, without Playwright waiting for aria-disabled to clear.
    const bounds = await row.boundingBox(); expect(bounds).not.toBeNull();
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await expect(palette(page)).toBeVisible();
    for (const [id, query, label] of [['vis:hide', 'Hide Selection', 'Hide Selection'], ['author:undo', 'undo', 'Undo']]) {
      const option = (await find(page, id, query)).row;
      await expect(option.locator('[data-command-label]')).toHaveText(label);
      const layout = await option.evaluate(element => {
        const title = element.querySelector<HTMLElement>('[data-command-label]')!;
        const reason = document.getElementById(element.getAttribute('aria-describedby')!)!;
        return { titleWidth: title.clientWidth, textWidth: title.scrollWidth,
          titleBottom: title.getBoundingClientRect().bottom, reasonTop: reason.getBoundingClientRect().top };
      });
      expect(layout.titleWidth, 'visible command title has room').toBeGreaterThan(35);
      expect(layout.textWidth, 'short command name is not clipped by its reason').toBeLessThanOrEqual(layout.titleWidth);
      expect(layout.reasonTop, 'reason has a separate line below the command').toBeGreaterThanOrEqual(layout.titleBottom);
    }
    await run(page, 'settings:privacy', 'action log');
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(settings.getByRole('tab', { name: 'Privacy', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(settings.locator('#settings-analytics-opt-out')).toBeVisible();
    const toggle = settings.locator('#settings-analytics-opt-out');
    const before = await toggle.getAttribute('aria-checked');
    await toggle.click(); await expect(toggle).not.toHaveAttribute('aria-checked', before!);
    await page.keyboard.press('Escape');
    await run(page, 'settings:display', 'navigation preset');
    await expect(settings.getByRole('tab', { name: 'Display', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(settings.getByText('SpaceMouse', { exact: true }).first()).toBeVisible();
  });

  test(`${context.name}: palette quick search reaches recents, cycling, native buttons and colorful theme (#8947)`, async ({ page }, info) => {
    await start(page, true, context);
    await assertStableLabels(page, 'vis:hide', true);
    await wall(page);
    await assertStableLabels(page, 'vis:hide', false);
    await run(page, 'search:inline', 'recent queries');
    const input = page.getByRole('combobox', { name: 'Search entities', exact: true });
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await page.keyboard.type('wall');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('wall');
    await expect(page.locator('#search-inline-popover').getByRole('option').first()).toBeVisible();
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().searchVimCycle?.results.length ?? 0)).toBeGreaterThan(1);
    const expectedNext = await page.evaluate(() => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const cycle = state.searchVimCycle;
      if (!cycle || cycle.results.length < 2) throw new Error('A real multi-result cycle is required');
      const next = cycle.results[(cycle.index + 1) % cycle.results.length];
      return { modelId: next.modelId, expressId: next.expressId, globalId: state.toGlobalId(next.modelId, next.expressId) };
    });
    // Native Tab moves out of text entry; n then invokes the real cycle binding.
    await input.press('Tab');
    await expect(page.getByRole('button', { name: 'Advanced filter', exact: true })).toBeFocused();
    await page.keyboard.press('n');
    await expect.poll(() => page.evaluate(() => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      return { modelId: state.selectedEntity?.modelId, expressId: state.selectedEntity?.expressId,
        globalId: state.selectedEntityId, multiSelection: [...state.selectedEntityIds] };
    })).toEqual({ ...expectedNext, multiSelection: [] });
    await run(page, 'search:inline', 'quick search');
    await expect(input).toBeFocused();
    await input.fill('');
    const recents = page.locator('#search-inline-popover');
    const recent = recents.getByRole('option', { name: 'wall', exact: true });
    await expect(recent).toBeVisible();
    await recent.press('Space');
    await expect(input).toHaveValue('wall');
    await input.fill('');
    await recents.getByRole('button', { name: 'Clear', exact: true }).press('Enter');
    await expect(recents).toBeHidden();
    await run(page, 'search:inline', 'quick search');
    await expect(input).toBeFocused();
    await expect(recents).toBeHidden();
    await input.press('Tab');
    await page.getByRole('button', { name: 'Advanced filter', exact: true }).press('Enter');
    await expect(page.getByRole('tab', { name: 'Filter', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await run(page, 'pref:colorful', 'rainbow');
    await expect(page.locator('html')).toHaveClass(/\bcolorful\b/);
    const { row } = await find(page, 'pref:colorful', 'rainbow');
    await expect(row).toContainText('On');
    await info.attach(`${context.name}-colorful-palette.png`, { body: await page.screenshot(), contentType: 'image/png' });
    await run(page, 'pref:colorful', 'rainbow');
    await expect(page.locator('html')).not.toHaveClass(/\bcolorful\b/);
  });

  test(`${context.name}: native fallback Open and Add choosers retain user activation (#8947)`, async ({ page }) => {
    // Exercise the production input fallback, with the Chromium-only API absent.
    // No picker handler or load result is substituted. File System Access needs separate evidence.
    await page.addInitScript(() => { Reflect.deleteProperty(window, 'showOpenFilePicker'); });
    await start(page, false, context);
    expect(await page.evaluate(() => 'showOpenFilePicker' in window)).toBe(false);
    for (const [id, query] of [['file:open', 'Open File'], ['file:add-model', 'Add model']]) {
      const { row, search } = await find(page, id, query);
      await expect(row).not.toHaveAttribute('aria-disabled', 'true');
      const chooserPromise = page.waitForEvent('filechooser');
      // Native click for narrow touch-sized UI; Enter for desktop keyboard activation.
      if (context.name === 'narrow-dark') await row.click();
      else {
        const count = await palette(page).getByRole('option').count();
        for (let n = 0; n < count && await row.getAttribute('aria-selected') !== 'true'; n++) await search.press('ArrowDown');
        await expect(row).toHaveAttribute('aria-selected', 'true');
        await search.press('Enter');
      }
      const chooser = await chooserPromise;
      expect(chooser.isMultiple()).toBe(true);
      expect(await chooser.element().getAttribute('accept')).toMatch(/ifc/i);
      await chooser.setFiles([]); // Cancel; never substitute a fake file or load result.
      await expect(palette(page)).toBeHidden();
    }
  });
}

test('loaded unselected → selected → hidden wall reaches renderer; author/class hosts and measurement tabs (#8947)', async ({ page }, info) => {
  await start(page, true);
  const launcher = page.getByRole('button', { name: /Commands…/ }).first();
  await launcher.focus();
  await expect(launcher).toBeFocused();
  const { row } = await find(page, 'vis:hide', 'hide');
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toContainText('Select elements');
  const id = await wall(page); // Canonical renderer selection of a real parsed entity.
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  const owner = await page.evaluate(id => (globalThis as typeof globalThis & {
    __ifc_lite_scene_owner__: (id: number) => SceneOwnerSnapshot;
  }).__ifc_lite_scene_owner__(id), id);
  expect(!!owner.flat?.length || owner.instance, 'selected wall has real resident geometry').toBe(true);
  // #8947: first opening must survive the palette's delayed close autofocus.
  await run(page, 'elements:entity-actions', 'Copy GlobalId');
  const entityMenu = page.getByRole('menu').filter({ has: page.locator('[data-command-id="context:copy-global-id"]') });
  await expect(entityMenu).toBeVisible();
  await expect.poll(() => entityMenu.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await info.attach('selected-entity-actions.png', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await expect(entityMenu).toBeHidden();
  await expect(launcher).toBeFocused();
  await run(page, 'vis:hide', 'hide');
  await expect.poll(async () => (await debug(page)).visibility.hiddenIds.includes(id)).toBe(true);
  expect(await page.evaluate(id => globalThis.__ifc_lite_viewer_store__.getState().hiddenEntities.has(id), id)).toBe(true);
  await info.attach('hidden-real-wall.png', { body: await page.screenshot(), contentType: 'image/png' });
  await run(page, 'author:bulk-properties', 'bulk properties');
  await expect(page.getByRole('dialog', { name: /Bulk Property Editor/i })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Target source', exact: true })).toBeVisible();
  await info.attach('author-bulk-host.png', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await run(page, 'elements:class-filter', 'class visibility');
  const classes = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Visibility', exact: true }) });
  await expect(classes).toBeVisible();
  const classToggle = classes.getByRole('switch').first();
  await expect(classToggle).toBeVisible();
  const classBefore = await classToggle.getAttribute('aria-checked');
  await classToggle.click();
  await expect(classToggle).not.toHaveAttribute('aria-checked', classBefore!);
  await info.attach('class-visibility-host.png', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await run(page, 'measure:angle', 'measure angle');
  await expect(page.getByRole('radiogroup', { name: 'Measure mode', exact: true }).getByRole('radio', { name: 'Angle', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radiogroup', { name: 'Angle kind', exact: true })).toBeVisible();
  await info.attach('actual-angle-tool.png', { body: await page.screenshot(), contentType: 'image/png' });
  for (const [tab, label] of [['point', 'Point'], ['list', 'List'], ['quantities', 'Qty']]) {
    await run(page, `measure-panel:${tab}`, `measurements panel ${tab}`);
    await expect(page.getByRole('tablist', { name: 'Measurements', exact: true }).getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tabpanel"][data-state="active"]').filter({ visible: true }).last()).toBeVisible();
  }
});

test('new blank creates parsed IFC, real Model workspace and wall tool; existing session refuses replacement (#8947)', async ({ page }) => {
  await start(page);
  await run(page, 'file:new-blank', 'New blank model');
  await expect.poll(() => page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const model = s.models.get(s.activeModelId!);
    return s.models.size === 1 && model?.loadState === 'complete' &&
      !!model.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.length && s.session?.activeCommandId === 'wall.place';
  }), { timeout: 180_000 }).toBe(true);
  // The real rail groups creation tools when its measured height is limited.
  // Require the active wall's actual input flow, independent of rail layout.
  await expect(page.getByRole('navigation', { name: 'Model tools', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Thickness', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave the command', exact: true })).toBeVisible();
  const { row } = await find(page, 'file:new-blank', 'New blank model');
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toContainText('empty session');
});

test('edge and corner presets move actual renderer and repeat deterministically (#8947)', async ({ page }, info) => {
  await start(page, true);
  await page.waitForFunction(() => typeof (globalThis as Record<string, unknown>).__ifc_lite_view_projection__ === 'function');
  const matrices: number[][] = [];
  for (const name of ['front-top', 'front-right-top', 'front-top']) {
    const before = (await debug(page)).matrix;
    await run(page, `view:orientation:${name}`, name.replaceAll('-', ' '));
    await expect.poll(async () => (await debug(page)).matrix).not.toEqual(before);
    // Poll until the actual time-based camera transition settles, with a bounded stability window.
    await expect.poll(async () => {
      const a = (await debug(page)).matrix;
      await page.waitForTimeout(100);
      const b = (await debug(page)).matrix;
      return a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
    }).toBe(true);
    matrices.push((await debug(page)).matrix);
    await info.attach(`${name}-${matrices.length}.png`, { body: await page.screenshot(), contentType: 'image/png' });
  }
  expect(matrices[0].every((v, i) => Math.abs(v - matrices[2][i]) < 1e-5)).toBe(true);
  expect(matrices[0]).not.toEqual(matrices[1]);
});

test('live read-only role and retired model invalidate author context while palette stays open (#8947)', async ({ page }) => {
  await start(page, true, contexts[1]);
  const { row, search } = await find(page, 'author:bulk-properties', 'bulk properties');
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  // Context setup changes real role data only; canCollabEdit and all handlers remain production code.
  await page.evaluate(() => (globalThis.__ifc_lite_viewer_store__ as {
    getState(): ViewerState; setState(state: Partial<ViewerState>): void;
  }).setState({ collabRole: 'viewer' }));
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toContainText('Requires editor access');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await search.press('Enter'); await expect(palette(page)).toBeVisible();
  await expect(page.getByRole('dialog', { name: /Bulk Property Editor/i })).toHaveCount(0);
  await page.evaluate(() => (globalThis.__ifc_lite_viewer_store__ as {
    getState(): ViewerState; setState(state: Partial<ViewerState>): void;
  }).setState({ collabRole: null }));
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  // Canonical teardown of the actual model; this is model retirement, not extension-host retirement.
  await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    s.removeModel([...s.models.keys()][0]);
  });
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toContainText(/Load a model/);
  // aria-disabled is intentionally discoverable/clickable for its explanation.
  // Send the real pointer click without Playwright waiting for it to become enabled.
  await row.click({ force: true }); await expect(palette(page)).toBeVisible();
  await expect(page.getByRole('dialog', { name: /Bulk Property Editor/i })).toHaveCount(0);
});
