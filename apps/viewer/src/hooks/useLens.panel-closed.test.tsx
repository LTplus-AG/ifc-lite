/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5877: an active lens keeps applying while the Lens panel is closed.
 *
 * Evaluation and the hide sync used to be effects of `LensPanel`, a panel body
 * that unmounts when its panel closes. The lens stayed active (colours, a
 * claim on the hidden channel) while nothing re-evaluated it, so a model
 * federated in afterwards was never hidden by it, and Home wiped its hides
 * while re-sending its colours. These tests mount ONLY `useLens` — what
 * `LensRuntimeHost` mounts for the viewer's lifetime — never the panel, over
 * real parsed models at 1 and N federated models.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { Lens } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import { resetVisibilityForHomeFromStore } from '@/store/homeView';
import { useLens } from './useLens.js';

/** What `LensRuntimeHost` mounts: `useLens()` and nothing else. */
function LensRuntimeProbe(): null {
  useLens();
  return null;
}

/** One wall (#1) and one slab (#2). */
const BODY = [
  "#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall',$,$,$,$,$,.STANDARD.);",
  "#2=IFCSLAB('0bbbbbbbbbbbbbbbbbbbbb',$,'Slab',$,$,$,$,$,.FLOOR.);",
].join('\n');

async function parse(): Promise<IfcDataStore> {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', BODY, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

const HIDE_WALLS: Lens = {
  id: 'hide-walls',
  name: 'Hide walls',
  rules: [{
    id: 'walls',
    name: 'Walls',
    enabled: true,
    criteria: { type: 'ifcType', ifcType: 'IfcWall' },
    action: 'hide',
    color: '#000000',
  }],
};

let root: Root | null = null;

async function mountHost(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<LensRuntimeProbe />);
  });
}

/** Register + add a model the way `useIfcLoader.ts` does. Returns the wall's global id. */
async function loadModel(modelId: string): Promise<number> {
  const store = await parse();
  let wallGlobalId = 0;
  await act(async () => {
    const idOffset = useViewerStore.getState().registerModelOffset(modelId, 2);
    useViewerStore.getState().addModel({
      id: modelId, name: modelId, ifcDataStore: store, geometryResult: null,
      visible: true, collapsed: false, schemaVersion: 'IFC4', loadedAt: Date.now(),
      fileSize: 0, idOffset, maxExpressId: 2, loadState: 'complete',
    });
    wallGlobalId = useViewerStore.getState().toGlobalId(modelId, 1);
  });
  return wallGlobalId;
}

async function activateLens(): Promise<void> {
  await act(async () => {
    useViewerStore.setState({ savedLenses: [HIDE_WALLS], activeLensId: HIDE_WALLS.id });
  });
}

const sorted = (ids: Iterable<number>): number[] => [...ids].sort((a, b) => a - b);

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({
    savedLenses: [], activeLensId: null, lensColorMap: new Map(), lensAppliedColors: null,
    lensHiddenIds: new Set(), lensAppliedHiddenIds: [], lensRuleCounts: new Map(),
    lensRuleEntityIds: new Map(), hiddenEntities: new Set(), isolatedEntities: null,
    lensRuleIsolation: null,
  });
});

for (const modelCount of [1, 3]) {
  describe(`useLens with the Lens panel closed, ${modelCount} model(s) (#5877)`, () => {
    it('hides a model federated in AFTER the lens was activated', async () => {
      await mountHost();
      const walls: number[] = [];
      for (let i = 0; i < modelCount; i++) walls.push(await loadModel(`m${i}`));
      await activateLens();
      assert.deepEqual(sorted(useViewerStore.getState().hiddenEntities), sorted(walls),
        'precondition: every loaded model\'s wall is lens-hidden');

      const lateWall = await loadModel('late');
      assert.deepEqual(sorted(useViewerStore.getState().hiddenEntities), sorted([...walls, lateWall]),
        'the late model\'s wall must be hidden by the still-active lens');
    });

    it('Home keeps the active lens\'s hides, drops the user\'s, and deactivation restores all', async () => {
      await mountHost();
      const walls: number[] = [];
      for (let i = 0; i < modelCount; i++) walls.push(await loadModel(`m${i}`));
      await activateLens();
      const slab = useViewerStore.getState().toGlobalId('m0', 2);
      await act(async () => { useViewerStore.getState().hideEntities([slab]); });

      await act(async () => { resetVisibilityForHomeFromStore('home'); });
      const after = useViewerStore.getState();
      assert.deepEqual(sorted(after.hiddenEntities), sorted(walls),
        'Home must keep exactly the lens hides and drop the manual slab hide');
      assert.deepEqual(sorted(after.lensAppliedHiddenIds), sorted(walls),
        'the lens must own every id it still hides, or deactivation could not restore them');

      await act(async () => { useViewerStore.setState({ activeLensId: null }); });
      assert.deepEqual(sorted(useViewerStore.getState().hiddenEntities), [],
        'deactivating the lens after Home restores every lens hide');
    });

    it('Home does not transfer ownership of a manually hidden wall to the lens', async () => {
      await mountHost();
      const walls: number[] = [];
      for (let i = 0; i < modelCount; i++) walls.push(await loadModel(`m${i}`));
      const manualWall = walls[0];
      const manualSlab = useViewerStore.getState().toGlobalId('m0', 2);
      await act(async () => { useViewerStore.getState().hideEntities([manualWall]); });
      await activateLens();
      assert.deepEqual(sorted(useViewerStore.getState().lensAppliedHiddenIds), sorted(walls.slice(1)),
        'the lens must not claim a wall hidden before it was activated');
      await act(async () => { useViewerStore.getState().hideEntities([manualSlab]); });

      await act(async () => { resetVisibilityForHomeFromStore('home'); });
      const afterHome = useViewerStore.getState();
      assert.deepEqual(sorted(afterHome.hiddenEntities), sorted(walls),
        'Home keeps lens matches, including the manual overlap, but clears the slab');
      assert.deepEqual(sorted(afterHome.lensAppliedHiddenIds), sorted(walls.slice(1)),
        'Home must not change ownership of the overlapping wall');

      await act(async () => { useViewerStore.setState({ activeLensId: null }); });
      assert.deepEqual(sorted(useViewerStore.getState().hiddenEntities), [manualWall],
        'deactivating the lens must leave the manual wall hidden');
    });

    for (const reset of ['showAll', 'showAllInAllModels'] as const) {
      it(`${reset} keeps lens ownership separate from a manual overlap (#5869)`, async () => {
        await mountHost();
        const walls: number[] = [];
        for (let i = 0; i < modelCount; i++) walls.push(await loadModel(`m${i}`));
        const manualWall = walls[0];
        const slab = useViewerStore.getState().toGlobalId('m0', 2);
        // Start with the wall hidden by the user, then activate the lens so
        // it claims only walls that were not already hidden.
        await act(async () => { useViewerStore.setState({ activeLensId: null }); });
        await act(async () => { useViewerStore.getState().hideEntities([manualWall]); });
        await activateLens();
        await act(async () => { useViewerStore.getState().hideEntities([slab]); });

        await act(async () => { useViewerStore.getState()[reset](); });
        const afterReset = useViewerStore.getState();
        assert.deepEqual(sorted(afterReset.hiddenEntities), sorted(walls),
          `${reset} clears the manual slab hide but retains all lens matches`);
        assert.deepEqual(sorted(afterReset.lensAppliedHiddenIds), sorted(walls.slice(1)),
          `${reset} must not claim the manually hidden wall`);

        await act(async () => { useViewerStore.setState({ activeLensId: null }); });
        assert.deepEqual(sorted(useViewerStore.getState().hiddenEntities), [manualWall]);
      });
    }

    it('deactivating the lens releases the rule isolation it still owns', async () => {
      await mountHost();
      const walls: number[] = [];
      for (let i = 0; i < modelCount; i++) walls.push(await loadModel(`m${i}`));
      await activateLens();
      // A rule-row click, recorded as the panel records it; then the panel closes.
      await act(async () => {
        useViewerStore.getState().isolateEntities(walls);
        useViewerStore.getState().setLensRuleIsolation({ ruleId: 'walls', entityIds: walls });
      });

      // A flavor switch clears the active lens with no panel mounted.
      await act(async () => { useViewerStore.setState({ activeLensId: null }); });
      const after = useViewerStore.getState();
      assert.equal(after.isolatedEntities, null, 'the orphaned lens isolation must be released');
      assert.equal(after.lensRuleIsolation, null, 'and its ownership record dropped');
    });

    it('deactivating the lens leaves an isolation the user applied since', async () => {
      await mountHost();
      const walls: number[] = [];
      for (let i = 0; i < modelCount; i++) walls.push(await loadModel(`m${i}`));
      await activateLens();
      const slab = useViewerStore.getState().toGlobalId(`m${modelCount - 1}`, 2);
      await act(async () => {
        useViewerStore.getState().setLensRuleIsolation({ ruleId: 'walls', entityIds: walls });
        useViewerStore.getState().isolateEntities([slab]);
      });

      await act(async () => { useViewerStore.setState({ activeLensId: null }); });
      const after = useViewerStore.getState();
      assert.deepEqual(sorted(after.isolatedEntities ?? []), [slab], 'the user\'s isolation stays');
      assert.equal(after.lensRuleIsolation, null, 'only the stale lens claim drops');
    });
  });
}
