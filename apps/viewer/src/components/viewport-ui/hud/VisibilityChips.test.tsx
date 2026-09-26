/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5882: the mounted HUD reports and clears every registry mechanism at 1/N models. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { ComponentType } from 'react';
import { useViewerStore, type ViewerState } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, click, render } from '@/test/render';
import { VISIBILITY_REASONS, type VisibilityReasonId } from '@/lib/visibility/visibility-reasons';
import { ViewportHud } from './ViewportHud';

const state = () => useViewerStore.getState();
const OFFSET = 1_000;
const chips = () => [...document.querySelectorAll<HTMLElement>('[data-visibility-reason]')];
const chipIds = () => chips().map((node) => node.dataset.visibilityReason);

let initial: ViewerState;
beforeEach(() => { initial = state(); });
afterEach(() => {
  cleanup();
  useViewerStore.setState(initial, true);
});

function seedModels(count: number): number {
  const models = Array.from({ length: count }, (_, index) => fixtureModel(`m${index}`, { idOffset: index * OFFSET }));
  useViewerStore.setState({
    ...fixtureModels(...models),
    hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null, classFilter: null,
    selectedStoreys: new Set(), activeLensId: null, lensHiddenIds: new Set(), lensAppliedHiddenIds: [],
    typeVisibility: { spaces: false, spatialZones: false, openings: false, virtualElements: false, site: true, ifcAnnotations: true, ifcGrid: true },
    typeViewMode: 'model', hasTypeGeometry: false, hostHiddenIfcTypes: null,
    levelDisplayMode: 'stacked',
  });
  return (count - 1) * OFFSET;
}

const ACTIVATE: Record<VisibilityReasonId, (offset: number) => Partial<ViewerState>> = {
  hidden: (o) => ({ hiddenEntities: new Set([o + 1]) }),
  isolation: (o) => ({ isolatedEntities: new Set([o + 2]) }),
  ghost: (o) => ({ ghostExceptEntities: new Set([o + 3]) }),
  classFilter: (o) => ({ classFilter: { ids: new Set([o + 4]), label: 'IfcWall' } }),
  storey: (o) => ({ selectedStoreys: new Set([o + 5]) }),
  exploded: () => ({ levelDisplayMode: 'exploded' }),
  modelHidden: () => {
    const models = new Map(state().models);
    const [id, model] = [...models].at(-1)!;
    models.set(id, { ...model, visible: false });
    return { models };
  },
  lens: (o) => ({
    activeLensId: 'lens', lensHiddenIds: new Set([o + 6]), lensAppliedHiddenIds: [o + 6],
    hiddenEntities: new Set([o + 6]),
  }),
  typeVisibility: () => ({ typeVisibility: { ...state().typeVisibility, site: false } }),
  typeViewMode: () => ({ typeViewMode: 'types', hasTypeGeometry: true }),
  hostTypes: () => ({ hostHiddenIfcTypes: new Set(['IFCSPACE']) }),
};

async function mount() {
  // The old indicator is the observable pre-change UI. On a production
  // revert, mount it and assert the actual missing reason chips/actions.
  const replacementPath = './VisibilityChips.js';
  const previousPath = '../../viewer/LevelDisplayIndicator.js';
  const StatusChip: ComponentType = await import(replacementPath)
    .then((module) => module.VisibilityChips)
    .catch(async () => (await import(previousPath)).LevelDisplayIndicator);
  return render(<><ViewportHud /><StatusChip /></>);
}

it('shows no status chip or reset action when nothing hides geometry (#5882)', async () => {
  seedModels(1);
  await mount();
  assert.deepEqual(chipIds(), []);
  assert.equal([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Reset everything')), false);
});

for (const modelCount of [1, 3]) {
  describe(`visibility chips at ${modelCount} model(s) (#5882)`, () => {
    for (const reason of VISIBILITY_REASONS) {
      it(`shows ${reason.id} alone and ${reason.resetPolicy === 'kept' ? 'explains it is kept' : 'clears only it'}`, async () => {
        const offset = seedModels(modelCount);
        act(() => useViewerStore.setState(ACTIVATE[reason.id](offset)));
        await mount();
        assert.deepEqual(chipIds(), [reason.id], 'one chip for the active reason');
        const chip = chips()[0];
        assert.ok(chip.textContent?.trim(), 'the reason has a readable label');
        const dismiss = chip.querySelector('button[aria-label^="Clear "]');
        if (reason.resetPolicy === 'kept') {
          assert.equal(dismiss, null, 'Show all keeps this mechanism');
          assert.match(chip.title, /Show all keeps this setting/);
        } else {
          assert.ok(dismiss, 'a resettable reason has a labelled ×');
          click(dismiss);
          assert.deepEqual(chipIds(), [], '× clears the one active mechanism');
        }
      });
    }

    it('Reset everything clears resettable reasons and leaves kept settings', async () => {
      const offset = seedModels(modelCount);
      const models = new Map(state().models);
      const [id, model] = [...models].at(-1)!;
      models.set(id, { ...model, visible: false });
      act(() => useViewerStore.setState({
        models,
        hiddenEntities: new Set([offset + 1, offset + 2]),
        activeLensId: 'lens', lensHiddenIds: new Set([offset + 2]), lensAppliedHiddenIds: [offset + 2],
        typeVisibility: { ...state().typeVisibility, site: false },
      }));
      await mount();
      assert.deepEqual(chipIds(), ['hidden', 'modelHidden', 'lens', 'typeVisibility']);
      assert.equal(chips().find((chip) => chip.dataset.visibilityReason === 'modelHidden')?.textContent?.trim(),
        `Model hidden · 1 of ${modelCount} model${modelCount === 1 ? '' : 's'}`);
      const resetButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Reset everything'));
      assert.ok(resetButton);
      click(resetButton);
      assert.deepEqual(chipIds(), ['lens', 'typeVisibility']);
      assert.equal(state().models.get(id)?.visible, true);
      assert.deepEqual(state().hiddenEntities, new Set([offset + 2]), 'lens-owned hide survives');
    });

    it('dismissing one row leaves the other active reasons alone', async () => {
      const offset = seedModels(modelCount);
      act(() => useViewerStore.setState({
        hiddenEntities: new Set([offset + 1]),
        isolatedEntities: new Set([offset + 2]),
        typeVisibility: { ...state().typeVisibility, site: false },
      }));
      await mount();
      assert.deepEqual(chipIds(), ['hidden', 'isolation', 'typeVisibility']);
      const dismissHidden = chips()[0].querySelector('button[aria-label^="Clear "]');
      assert.ok(dismissHidden);
      click(dismissHidden);
      assert.deepEqual(chipIds(), ['isolation', 'typeVisibility']);
      assert.deepEqual(state().isolatedEntities, new Set([offset + 2]));
      assert.equal(state().typeVisibility.site, false);
    });
  });
}
