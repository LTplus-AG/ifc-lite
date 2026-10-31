/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955 M2 decision 3: mesh-derived exports and tools (GLB/KMZ/ion/USD,
 * measure, clash) are disabled for a retained, shape-only model, with the
 * shape-only reason — one guard, `hasRetainedShapeOnlyModel`. The same
 * controls on the same model without a retained summary stay available.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { seedCoincidentWalls } from '@/test/clash-run-fixture.js';
import { useViewerStore } from '@/store';
import { RETAINED_SHAPE_ONLY_REASON, type RetainedGeometrySummary } from './retainedGeometry';
import { useExportCommands, type ResolvedExportCommand } from '@/components/viewer/toolbar/useExportCommands';
import { ClashPanel } from '@/components/viewer/ClashPanel';
// The retained module registers the shape-only reason's English text.
import '@/lib/retained/retainedLoad';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });
// @tanstack/virtual-core 3.19+ reads the scroll viewport from clientWidth/clientHeight
// (rows are still measured with offsetHeight), so stub both channels.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600, configurable: true });

const SUMMARY: RetainedGeometrySummary = {
  kernel: 'retained', candidates: 2, published: 2, refused: [], cancelled: 0, obligationsUnmet: ['IfcAppearance'], completeness: 'complete',
};

async function seed(retained: boolean): Promise<void> {
  await seedCoincidentWalls(1);
  if (!retained) return;
  const models = new Map(useViewerStore.getState().models);
  for (const [id, model] of models) models.set(id, { ...model, retainedGeometry: SUMMARY });
  act(() => useViewerStore.setState({ models }));
}

let exportCommands: ResolvedExportCommand[] = [];
function ExportProbe() {
  exportCommands = useExportCommands('ribbon').commands;
  return null;
}
const exportState = (id: string) => {
  const found = exportCommands.find((c) => c.command.id === id);
  assert.ok(found, id);
  return { disabled: found.disabled, reason: found.disabledReasonKey };
};

afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState({ models: new Map(), activeModelId: null, activeTool: 'select', clashResult: null, clashRunning: false }));
});

describe('#7955 M2 shape-only guard', () => {
  for (const retained of [false, true]) {
    it(`mesh-derived exports ${retained ? 'are disabled with the shape-only reason' : 'stay available'} (${retained ? 'retained' : 'exact'} model)`, async () => {
      await seed(retained);
      render(<ExportProbe />);
      for (const id of ['glb', 'kmz', 'ion', 'usd']) {
        const state = exportState(id);
        assert.equal(state.reason, retained ? RETAINED_SHAPE_ONLY_REASON : undefined, id);
        // Cesium ion also needs the legacy single-model store, which this fixture leaves empty.
        if (retained || id !== 'ion') assert.equal(state.disabled, retained, id);
      }
      assert.deepEqual(exportState('ifc'), { disabled: false, reason: undefined }, 'the source-based IFC export is unaffected');
    });

    it(`measure ${retained ? 'cannot open' : 'opens'} (${retained ? 'retained' : 'exact'} model)`, async () => {
      await seed(retained);
      act(() => useViewerStore.getState().setActiveTool('measure'));
      assert.equal(useViewerStore.getState().activeTool, retained ? 'select' : 'measure');
    });

    it(`clash detection ${retained ? 'is disabled with the shape-only reason' : 'can be started'} (${retained ? 'retained' : 'exact'} model)`, async () => {
      await seed(retained);
      const container = render(<ClashPanel />);
      const detect = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Detect all clashes');
      assert.ok(detect);
      assert.equal(detect.disabled, retained);
      const reason = 'Unavailable while retained geometry or presentation is incomplete. Reload it with the exact kernel to use this.';
      assert.equal(detect.title, retained ? reason : '');
      for (const label of ['Find duplicates', 'Discipline matrix']) {
        const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
        assert.ok(button, label);
        assert.equal(button.disabled, retained, label);
        if (retained) assert.equal(button.title, reason, label);
      }
    });
  }
});

// #7955 M11-Z: a complete, fully presented retained model has the required authority.
it('M11-Z enables mesh exports on a complete final retained model', async () => {
  await seed(true);
  const models = new Map(useViewerStore.getState().models);
  for (const [id, model] of models) models.set(id, { ...model, retainedGeometry: { ...SUMMARY, obligationsUnmet: [] } });
  act(() => useViewerStore.setState({ models }));
  render(<ExportProbe />);
  assert.equal(exportState('glb').disabled, false);
});
