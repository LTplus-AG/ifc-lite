/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8947 R1: bounded real destinations; run alongside the unchanged #8946 UX suite. */
import { chromium, expect, test as base, type Page } from '@playwright/test';
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

for (const context of contexts) {
  test(`${context.name}: unloaded selection command explains refusal; Settings sections reach real controls (#8947)`, async ({ page }) => {
    await start(page, false, context);
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
  await expect(page.locator('[data-rail-tool="wall.place"]')).toHaveAttribute('aria-pressed', 'true');
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
