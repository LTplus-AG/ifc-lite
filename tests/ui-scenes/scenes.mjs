/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fixed scene set for the UI overhaul council (#8802).
 *
 * Every round of the hill climb captures exactly these states, so a
 * reviewer always compares like with like. Change a scene only between
 * campaigns: editing one mid-campaign invalidates the frozen baseline.
 *
 * A scene is `{ id, title, model, viewport?, firstRun?, run(ctx) }`. `model` is a
 * same-origin sample path (or null for the empty viewer); `run` drives the
 * page into the state to capture, using store actions where a click path
 * would be fragile and real clicks where the click IS the state (menus).
 * Only bundled public samples are used, so captures may be shared publicly.
 */

const ARCH = '/samples/building-architecture.ifc';
const DESKTOP = { width: 1600, height: 1000 };

/** First express id of an IFC type in the first loaded model. */
async function firstOfType(page, ...types) {
  return page.evaluate((types) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    for (const type of types) {
      const ids = model.ifcDataStore?.entityIndex.byType.get(type);
      if (ids && ids.length > 0) return { modelId: model.id, expressId: ids[0] };
    }
    throw new Error(`no entity of ${types.join('/')}`);
  }, types);
}

async function selectFirst(page, ...types) {
  const { modelId, expressId } = await firstOfType(page, ...types);
  await page.evaluate(({ modelId, expressId }) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setSelectedEntityId(state.toGlobalId(modelId, expressId));
  }, { modelId, expressId });
}

async function showPanel(page, id) {
  await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().showWorkspacePanel(id), id);
}

/**
 * A plan cut the way the section tool's storey list makes one: the lowest
 * storey's floor plus 1.2 m (PLAN_CUT_HEIGHT_M), as a `down` position over the
 * model's vertical range. The default cut sits at 50% of the bounds, which on
 * a two-storey house with a roof passes through wall heads and shows slivers.
 */
async function planCutAtGroundStorey(page) {
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    const bounds = model.geometryResult?.coordinateInfo?.shiftedBounds;
    if (!bounds) throw new Error('no model bounds for the plan cut');
    const { min, max } = { min: bounds.min.y, max: bounds.max.y };
    const elevations = [...(model.ifcDataStore?.spatialHierarchy?.storeyElevations?.values() ?? [])];
    const floor = elevations.length > 0 ? Math.min(...elevations) : min;
    const inRange = floor >= min - 1e-3 && floor <= max + 1e-3;
    const cut = (inRange ? floor : min) + 1.2;
    state.setSectionPlaneAxis('down');
    state.setSectionPlanePosition(((cut - min) / (max - min)) * 100);
  });
}

/** Opens the Info dialog on `tab` the way the Learn command does, and waits
 *  for its open animation to finish. */
async function openInfoDialog(page, tab) {
  await page.evaluate((t) => window.dispatchEvent(new CustomEvent('ifc-lite:show-shortcuts', { detail: { tab: t } })), tab);
  await page.waitForSelector(`[role="dialog"] [role="tabpanel"][data-state="active"]`);
  await page.evaluate(async () => {
    for (const animation of document.getAnimations()) animation.finish();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/**
 * Open Settings the way every opener does (the `ifc-lite:open-settings`
 * window event, #5857), then wait for its dialog. `toEnd` scrolls every
 * element inside the dialog that a user could scroll (`overflow-y` auto or
 * scroll) to its end, so a still shows whether
 * the last settings are reachable; on a build where nothing scrolls, the
 * clipped body shows as clipped.
 */
async function openSettingsDialog(page, { toEnd = false } = {}) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ifc-lite:open-settings', { detail: { section: 'general' } })));
  await page.waitForSelector('[data-settings-dialog]');
  // General mounts two groups lazily, about 1.5 s after the dialog opens and
  // after the network is already idle. Wait until the dialog's content has
  // stopped growing for a full second (bounded at 8 s), so neither scene shows
  // partial content and the end scene scrolls the full body.
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    const dialog = document.querySelector('[data-settings-dialog]');
    const size = () => {
      let tallest = 0;
      for (const el of dialog.querySelectorAll('*')) tallest = Math.max(tallest, el.scrollHeight);
      return `${dialog.querySelectorAll('*').length}:${tallest}`;
    };
    let last = size();
    let still = 0;
    for (let waited = 0; waited < 8000 && still < 10; waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
      const now = size();
      still = now === last ? still + 1 : 0;
      last = now;
    }
  });
  if (!toEnd) return;
  // General loads two groups lazily (null Suspense fallbacks), so content can
  // grow after the first scroll. Scroll, wait two frames, and repeat until
  // nothing grows and every scroller rests at its end (bounded, ~3 s).
  await page.evaluate(async () => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const scrollers = () => {
      const dialog = document.querySelector('[data-settings-dialog]');
      // Only what a user could scroll: `overflow: hidden` can still be
      // scrolled from code, which would show settings a phone cannot reach.
      return [dialog, ...dialog.querySelectorAll('*')].filter((el) => {
        const { overflowY } = getComputedStyle(el);
        return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
      });
    };
    let stable = 0;
    let last = '';
    for (let i = 0; i < 90 && stable < 3; i += 1) {
      for (const el of scrollers()) el.scrollTop = el.scrollHeight;
      await frames();
      const now = scrollers().map((el) => `${el.scrollHeight}:${Math.round(el.scrollTop + el.clientHeight)}`).join('|');
      const atEnd = scrollers().every((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
      stable = now === last && atEnd ? stable + 1 : 0;
      last = now;
    }
  });
}

export const SCENES = [
  {
    id: 'empty',
    title: 'Empty viewer, first run',
    model: null,
    firstRun: true,
    async run() {},
  },
  {
    id: 'loaded',
    title: 'Model loaded, default layout',
    model: ARCH,
    async run() {},
  },
  {
    id: 'selected-properties',
    title: 'Wall selected, properties panel',
    model: ARCH,
    async run({ page }) {
      await selectFirst(page, 'IFCWALLSTANDARDCASE', 'IFCWALL');
      await showPanel(page, 'properties');
    },
  },
  {
    id: 'hierarchy-types',
    title: 'Model tree grouped by type',
    model: ARCH,
    async run({ page }) {
      await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setHierarchyMode('type'));
      await showPanel(page, 'hierarchy');
    },
  },
  {
    id: 'isolated',
    title: 'Walls isolated',
    model: ARCH,
    async run({ page }) {
      await page.evaluate(() => {
        const state = globalThis.__ifc_lite_viewer_store__.getState();
        const model = [...state.models.values()][0];
        const index = model.ifcDataStore.entityIndex.byType;
        const ids = [...(index.get('IFCWALLSTANDARDCASE') ?? []), ...(index.get('IFCWALL') ?? [])];
        state.setIsolatedEntities(new Set(ids.map((id) => state.toGlobalId(model.id, id))));
      });
    },
  },
  {
    id: 'command-palette',
    title: 'Command palette searching "wall"',
    model: ARCH,
    async run({ page }) {
      await page.keyboard.press('Control+k');
      await page.keyboard.type('wall');
    },
  },
  {
    id: 'lists',
    title: 'Lists (table) panel',
    model: ARCH,
    async run({ page }) { await showPanel(page, 'lists'); },
  },
  {
    id: 'validation',
    title: 'Validation panel',
    model: ARCH,
    async run({ page }) { await showPanel(page, 'validation'); },
  },
  {
    id: 'bcf',
    title: 'BCF issues panel',
    model: ARCH,
    async run({ page }) { await showPanel(page, 'bcf'); },
  },
  {
    id: 'clash',
    title: 'Clash panel',
    model: ARCH,
    async run({ page }) { await showPanel(page, 'clash'); },
  },
  {
    id: 'drawing',
    title: '2D plan drawing, ground storey cut',
    model: ARCH,
    async run({ page }) {
      await planCutAtGroundStorey(page);
      await showPanel(page, 'drawing');
    },
  },
  {
    id: 'shortcuts-dialog',
    title: 'Keyboard shortcuts dialog',
    model: ARCH,
    async run({ page }) { await page.keyboard.press('Shift+?'); },
  },
  {
    id: 'info-learn',
    title: 'Info dialog, Learn tab, in a small desktop window',
    model: ARCH,
    viewport: { width: 1033, height: 676 },
    async run({ page }) { await openInfoDialog(page, 'learn'); },
  },
  {
    id: 'mobile-info-learn',
    title: 'Phone, Info dialog on the Learn tab',
    model: ARCH,
    viewport: { width: 390, height: 844 },
    async run({ page }) { await openInfoDialog(page, 'learn'); },
  },
  {
    id: 'mobile-loaded',
    title: 'Phone, model loaded',
    model: ARCH,
    viewport: { width: 390, height: 844 },
    async run() {},
  },
  {
    id: 'mobile-settings',
    title: 'Phone, Settings open',
    model: ARCH,
    viewport: { width: 390, height: 844 },
    async run({ page }) { await openSettingsDialog(page); },
  },
  {
    id: 'mobile-settings-end',
    title: 'Phone, Settings scrolled to the end',
    model: ARCH,
    viewport: { width: 390, height: 844 },
    async run({ page }) { await openSettingsDialog(page, { toEnd: true }); },
  },
].map((scene) => ({ viewport: DESKTOP, ...scene }));
