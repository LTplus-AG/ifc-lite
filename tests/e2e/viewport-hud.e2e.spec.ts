/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewport HUD collision e2e (#5946, charter #5478; the gate for #5481).
 *
 * For every viewport state below, every `[data-hud-item]` the HUD placed —
 * plus the one HUD popover (the Section bar's Cap) — must (a) lie inside
 * the viewport, (b) not overlap any other HUD item, (c) not overlap the
 * ViewCube, and (d) not overlap a docked bottom panel (the Drawing panel
 * the section hint and Cap popover used to slide under, #5481). Layout is
 * only observable with real layout, so this runs in the browser with a
 * model loaded; states are driven through the store. A screenshot of each
 * state x width x scheme is attached to the test report as evidence.
 *
 * States (#5946): idle, selection, section, section + Cap popover, section
 * box (#5513: the bar's Box segment, its size readout and Fit), measure,
 * floor plan + Drawing panel, solo chip + parked section, banners, plus the
 * Model workspace command bars (split, slab, beam, room, window, ...).
 */

import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'fs';
import { join } from 'path';

const STORE = '__ifc_lite_viewer_store__';
const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

// #6365: authoring HUD states need the current Model workspace before a tool can mount.
async function enterModelWorkspace(page: Page): Promise<void> {
  // Streaming geometry can arrive before the IFC data store. Model workspace
  // entry is refused until an editable model has that store (#6365).
  await page.waitForFunction((key) => {
    const store = (globalThis as unknown as Record<string, {
      getState(): { models: Map<string, { ifcDataStore: unknown | null }> };
    }>)[key];
    return [...store.getState().models.values()].some((entry) => entry.ifcDataStore != null);
  }, STORE, { timeout: 180000 });
  await page.getByRole('tab', { name: 'Author', exact: true }).click();
  const model = page.getByRole('tabpanel', { name: 'Author' }).getByRole('button', { name: 'Model', exact: true });
  await model.click();
  await expect(model).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate((key) => {
    const store = (globalThis as unknown as Record<string, { getState(): { workspaceMode: string } }>)[key];
    return store.getState().workspaceMode;
  }, STORE)).toBe('model');
}

test('#5813 Measure Clear all uses the themed dialog', async ({ page }, testInfo) => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);
  await page.goto('/');
  await page.waitForFunction((key) => !!(globalThis as Record<string, unknown>)[key], STORE);
  await page.locator('input[type="file"]').first().setInputFiles(join(process.cwd(), FIXTURE));
  await page.waitForFunction((key) => {
    const store = (globalThis as Record<string, { getState(): { models: Map<string, unknown> } }>)[key];
    return store.getState().models.size > 0;
  }, STORE, { timeout: 180000 });
  await page.evaluate((key) => {
    const store = (globalThis as Record<string, { setState(value: object): void }>)[key];
    store.setState({
      activeTool: 'measure',
      measurements: [{
        id: 'dialog-measurement',
        start: { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 },
        end: { x: 1, y: 0, z: 0, screenX: 1, screenY: 0 },
        distance: 1,
      }],
    });
  }, STORE);

  const clear = page.locator('[data-testid="measure-toolbar"] button[aria-label="Clear all"]');
  await expect(clear).toBeVisible();
  await clear.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Clear every measurement? This cannot be undone.');
  await testInfo.attach('measure-clear-dialog.png', { body: await page.screenshot(), contentType: 'image/png' });

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(clear).toBeVisible();
  await clear.click();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(clear).toHaveCount(0);
});

type StoreState = Record<string, (...args: never[]) => unknown> & {
  models: Map<string, { ifcDataStore: { entityIndex: { byType: Map<string, number[]> } } | null }>;
};

/**
 * Each state is entered from the previous one, in the page (see the `enter`
 * table inside the test). `mayBeEmpty`: a state that legitimately places no
 * HUD item (nothing to collide) still runs the viewport/panel rules.
 */
const STATES: ReadonlyArray<{ name: string; settleMs?: number; mayBeEmpty?: boolean }> = [
  { name: 'idle', mayBeEmpty: true },
  { name: 'selection', mayBeEmpty: true },
  { name: 'split' },
  // #6232 M2.2: the placing commands' bars are the widest command bars; they stack rather than overrun the lane.
  { name: 'slab' },
  { name: 'beam' },
  // #6232 D2: the Column bar's Section picker follows its fields.
  { name: 'column' },
  // #6232 C2: Rotate carries a field and its Pivot toggle, on a selection.
  { name: 'rotate' },
  // The Room tool derives its rooms through wasm before its bar settles.
  { name: 'room', settleMs: 1500 },
  // #6232 A1: the hosted placing commands' bar (offset, sill, width, height).
  { name: 'window' },
  // #6232 C3: the Array bar (count, spacing, linear / polar, spacing / fit).
  { name: 'array' },
  // #6232 D1: the Stair bar (five fields and its riser summary) and the Railing bar (four fields, summary, Finish).
  { name: 'stair' },
  { name: 'railing' },
  // #6232 C5: the multi-split bar (scope, what splits, what is refused) beside its storey sweep.
  { name: 'splitMulti' },
  // #6232 C4: Push / Pull (a field and a readout) and Align (six edges and a count).
  { name: 'pushPull' },
  { name: 'align' },
  { name: 'measure' },
  { name: 'section' },
  { name: 'section+cap' },
  { name: 'section+box' },
  { name: 'floorplan+drawing', settleMs: 3000 },
  { name: 'parked+solo' },
  { name: 'banners' },
];

interface Box { name: string; left: number; top: number; right: number; bottom: number }

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Every rect the collision rule applies to, plus the viewport and any docked bottom panel. */
async function measure(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const out: Box[] = [];
    const rect = (name: string, el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ name, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    };
    document.querySelectorAll<HTMLElement>('[data-hud-region] [data-hud-item]').forEach((el, i) => {
      rect(`${el.closest<HTMLElement>('[data-hud-region]')!.dataset.hudRegion}#${i}`, el);
    });
    const popover = document.querySelector('[data-testid="section-cap-popover"]');
    if (popover) rect('cap-popover', popover);
    const cube = document.querySelector('[data-tour="viewcube"], [aria-label="View cube"], [data-viewcube]');
    if (cube) rect('viewcube', cube);
    const strip = document.querySelector('[data-bottom-strip]');
    if (strip) rect('bottom-panel', strip);
    rect('viewport', document.querySelector('[data-viewport]')!);
    return out;
  });
}

for (const width of [1280, 1600, 1920]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`HUD items never collide across ${STATES.length} states at ${width}px ${scheme}`, async ({ page }, testInfo) => {
      test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/');
      await page.waitForFunction((k) => !!(globalThis as Record<string, unknown>)[k], STORE, { timeout: 120000 });
      await page.locator('input[type="file"]').first().setInputFiles(join(process.cwd(), FIXTURE));
      await page.waitForFunction((k) => {
        const s = (globalThis as Record<string, { getState(): { models: Map<string, unknown>; geometryResult?: { meshes?: unknown[] } } }>)[k].getState();
        return s.models.size > 0 && (s.geometryResult?.meshes?.length ?? 0) > 0;
      }, STORE, { timeout: 180000 });
      await page.evaluate(([k, theme]) => {
        (globalThis as Record<string, { getState(): Record<string, (v: unknown) => void> }>)[k].getState().setTheme(theme);
      }, [STORE, scheme] as const);
      await expect(page.locator('[data-viewport]').first()).toBeAttached({ timeout: 60000 });
      await enterModelWorkspace(page);

      const failures: string[] = [];
      for (const state of STATES) {
        await page.evaluate(([k, name]) => {
          const api = (globalThis as unknown as Record<string, { getState(): StoreState; setState(p: object): void }>)[k];
          const enter: Record<string, (s: StoreState) => void> = {
            idle: (s) => s.setActiveTool('select'),
            selection: (s) => {
              const model = s.models.values().next().value;
              const wall = model?.ifcDataStore?.entityIndex.byType.get('IFCWALL')?.[0] ?? model?.ifcDataStore?.entityIndex.byType.get('IFCWALLSTANDARDCASE')?.[0];
              if (wall !== undefined) s.setSelectedEntityId(wall);
            },
            split: (s) => { s.setSelectedEntityId(null); s.startCommand('element.split'); },
            slab: (s) => s.startCommand('slab.place'),
            beam: (s) => s.startCommand('beam.place'),
            column: (s) => s.startCommand('column.place'),
            rotate: (s) => {
              const model = s.models.values().next().value;
              const wall = model?.ifcDataStore?.entityIndex.byType.get('IFCWALL')?.[0] ?? model?.ifcDataStore?.entityIndex.byType.get('IFCWALLSTANDARDCASE')?.[0];
              if (wall !== undefined) s.setSelectedEntityId(wall);
              s.startCommand('element.rotate');
            },
            room: (s) => s.startCommand('room.place'),
            window: (s) => s.startCommand('window.place'),
            array: (s) => s.startCommand('element.array'),
            stair: (s) => s.startCommand('stair.place'),
            railing: (s) => s.startCommand('railing.place'),
            splitMulti: (s) => { s.setSelectedEntityId(null); s.startCommand('split.multi'); },
            pushPull: (s) => { s.setSelectedEntityId(null); s.startCommand('element.pushPull'); },
            align: (s) => s.startCommand('element.align'),
            measure: (s) => s.setActiveTool('measure'),
            section: (s) => { s.setActiveTool('section'); s.setSectionPlaneAxis('down'); s.setSectionPlanePosition(50); },
            'section+cap': () => {},
            'section+box': () => {},
            'floorplan+drawing': (s) => { s.setSectionPlaneAxis('down'); s.setSectionPlanePosition(55); s.openPanelInHome('drawing'); },
            'parked+solo': (s) => { s.setActiveTool('select'); s.setLevelDisplayMode('solo'); },
            banners: (s) => {
              s.setLevelDisplayMode('stacked');
              api.setState({ mergeLayersPendingReload: true, geometryModePendingReload: true, landXmlUnitsRefusal: { fileName: 'road.xml', retry: () => {} } });
            },
          };
          enter[name](api.getState());
        }, [STORE, state.name] as const);
        if (state.name === 'split' || state.name === 'slab' || state.name === 'beam' || state.name === 'column' || state.name === 'rotate' || state.name === 'room' || state.name === 'window' || state.name === 'array' || state.name === 'stair' || state.name === 'railing' || state.name === 'splitMulti' || state.name === 'pushPull' || state.name === 'align') {
          const id = { split: 'element.split', slab: 'slab.place', beam: 'beam.place', column: 'column.place', rotate: 'element.rotate', room: 'room.place', window: 'window.place', array: 'element.array', stair: 'stair.place', railing: 'railing.place', splitMulti: 'split.multi', pushPull: 'element.pushPull', align: 'element.align' }[state.name];
          await expect(page.locator(`[data-hud-region] [data-command-id="${id}"]`)).toBeVisible();
        }
        if (state.name === 'section+cap') {
          await page.locator('[data-tool-bar="section"] button', { hasText: 'Cap' }).click();
          await expect(page.locator('[data-testid="section-cap-popover"]')).toBeVisible({ timeout: 10000 });
        }
        if (state.name === 'section+box') {
          // Through the bar, not the store: the segment fits the box to the model and the bar re-lays out.
          await page.locator('[data-tool-bar="section"] [role="radio"]', { hasText: 'Box' }).click();
          await expect(page.locator('[data-testid="section-box-size"]')).toBeVisible({ timeout: 10000 });
        }
        if (!state.mayBeEmpty) {
          await expect(page.locator('[data-hud-region] [data-hud-item]').first()).toBeVisible({ timeout: 60000 });
        }
        // The Room tool derives rooms through wasm; the Drawing panel generates a cut.
        await page.waitForTimeout(state.settleMs ?? 800);

        const boxes = await measure(page);
        await testInfo.attach(`${state.name}-${width}-${scheme}.png`, { body: await page.screenshot(), contentType: 'image/png' });
        if (state.name === 'section+cap') await page.keyboard.press('Escape');

        const viewport = boxes.find((b) => b.name === 'viewport')!;
        const panel = boxes.find((b) => b.name === 'bottom-panel');
        const items = boxes.filter((b) => b.name !== 'viewport' && b.name !== 'bottom-panel');
        if (!state.mayBeEmpty) expect(items.length, `${state.name}: the state placed at least one HUD item`).toBeGreaterThan(0);
        for (const a of items) {
          if (a.left < viewport.left || a.top < viewport.top || a.right > viewport.right || a.bottom > viewport.bottom) {
            failures.push(`${state.name}@${width}/${scheme}: ${a.name} leaves the viewport`);
          }
          if (panel && overlaps(a, panel)) failures.push(`${state.name}@${width}/${scheme}: ${a.name} overlaps the docked bottom panel`);
          for (const b of items) {
            if (a === b || a.name > b.name) continue;
            if (overlaps(a, b)) failures.push(`${state.name}@${width}/${scheme}: ${a.name} overlaps ${b.name}`);
          }
        }
        if (state.name === 'parked+solo') {
          const topLeft = items.filter((b) => b.name.startsWith('top-left#'));
          expect(topLeft.length, 'Solo chip + parked-section chip are both HUD items (#5481)').toBeGreaterThanOrEqual(2);
        }
      }
      expect(failures).toEqual([]);
    });
  }
}
