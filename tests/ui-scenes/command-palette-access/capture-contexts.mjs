#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8947: fixed access contexts, using the existing real-IFC/GPU capture protocol.
// Observations describe actual behavior; a baseline gap is not a harness failure.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SCENES } from '../scenes.mjs';

const outIndex = process.argv.indexOf('--out');
if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error('--out is required');
const out = resolve(process.argv[outIndex + 1]);
await mkdir(out, { recursive: true });
const observations = [];
const fixture = '/samples/building-architecture.ifc';

async function selectRealWall(page) {
  return page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    const index = model.ifcDataStore.entityIndex.byType;
    const expressId = (index.get('IFCWALLSTANDARDCASE') ?? index.get('IFCWALL'))?.[0];
    if (expressId === undefined) throw new Error('Real fixture has no wall');
    const globalId = state.toGlobalId(model.id, expressId);
    // Fixture setup uses the canonical renderer selection action, not synthetic geometry.
    state.setSelectedEntityId(globalId);
    return { modelId: model.id, expressId, globalId };
  });
}

for (const [id, context, query, execute] of [
  ['access-unloaded-hide', 'unloaded', 'hide', false],
  ['access-loaded-hide', 'loaded', 'hide', false],
  ['access-selected-hide', 'selected', 'hide', false],
  ['access-selected-hide-run', 'selected', 'hide', true],
  ['access-history', 'loaded', 'undo', false],
  ['access-settings-privacy', 'unloaded', 'privacy', false],
]) {
  SCENES.push({
    id, title: `${context}: ${query}${execute ? ' then execute Hide Selection' : ''}`,
    model: context === 'unloaded' ? null : fixture,
    viewport: { width: 1440, height: 900 },
    async run({ page }) {
      const target = context === 'selected' ? await selectRealWall(page) : null;
      await page.keyboard.press('Control+k');
      const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true });
      const search = dialog.getByRole('combobox');
      await search.fill(query);
      const before = await page.evaluate(() => {
        const state = globalThis.__ifc_lite_viewer_store__.getState();
        return { models: state.models.size, selectedId: state.selectedEntityId,
          hiddenCount: state.hiddenEntities.size };
      });
      const rows = await dialog.getByRole('option').evaluateAll(elements => elements.map(element => ({
        name: element.getAttribute('aria-label'), text: element.textContent,
        disabled: element.getAttribute('aria-disabled'), selected: element.getAttribute('aria-selected'),
      })));
      let outcome = null;
      if (execute) {
        await dialog.getByRole('option', { name: 'Hide Selection', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.waitForFunction(id => globalThis.__ifc_lite_viewer_store__.getState().hiddenEntities.has(id), target.globalId);
        outcome = await page.evaluate(id => {
          const state = globalThis.__ifc_lite_viewer_store__.getState();
          return { targetHidden: state.hiddenEntities.has(id), hiddenCount: state.hiddenEntities.size };
        }, target.globalId);
        assert.equal(outcome.targetHidden, true, 'canonical Hide Selection hides the parsed fixture wall');
        await page.keyboard.press('Control+k');
        await search.fill(query);
      }
      observations.push({ id, context, query, target, before, rows, outcome,
        theme: await page.locator('html').getAttribute('class') });
      await writeFile(resolve(out, 'context-observations.json'), JSON.stringify(observations, null, 2) + '\n');
    },
  });
}
await import('../capture.mjs');
