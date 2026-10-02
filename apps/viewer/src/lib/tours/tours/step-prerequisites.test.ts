/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Field `tour_step_broken` reason `prerequisite-not-met` (3.4.0):
 * welcome/inspect (6 users), welcome/structure (5), lens/isolate-legend (3).
 * Each is a step whose anchor only exists once an EARLIER, skippable step
 * did its work (load a model, select an element, apply a lens). These run the
 * REAL `prepare` of those steps against the store a skipper leaves behind and
 * assert the step's precondition is met afterwards.
 */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { EVENT_LOAD_FILE } from '../events.js';
import { ensureTourModel } from '../demo-kit.js';
import type { TourStep } from '../types.js';
import { WELCOME_TOUR, representativeElementId } from './welcome.js';
import { LENS_TOUR } from './lens.js';
import { RIBBON_TOUR } from './ribbon.js';

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

function step(tour: { steps: TourStep[] }, id: string): TourStep {
  const found = tour.steps.find((s) => s.id === id);
  assert.ok(found, `step ${id} exists`);
  return found;
}

/** A loaded model whose scene meshes carry federated GLOBAL ids (offset applied). */
function loadedModel(idOffset: number, meshes: Array<{ expressId: number; ifcType: string }>): FederatedModel {
  const model = fixtureModel('m', { idOffset });
  return { ...model, loadState: 'complete', geometryResult: { meshes, totalTriangles: 0 } } as unknown as FederatedModel;
}

function seedLoaded(model: FederatedModel): void {
  useViewerStore.setState({ ...fixtureModels(model), loading: false, geometryStreamingActive: false });
}

describe('welcome tour steps after a skipped select (#6720)', () => {
  afterEach(() => { useViewerStore.setState(originalState, true); });

  it('picks a wall, by its global id, as the element to read', () => {
    const model = loadedModel(1000, [
      { expressId: 1001, ifcType: 'IfcSlab' },
      { expressId: 1042, ifcType: 'IfcWallStandardCase' },
    ]);
    seedLoaded(model);
    assert.equal(representativeElementId(useViewerStore), 1042);
    seedLoaded(loadedModel(0, [{ expressId: 7, ifcType: 'IfcSlab' }]));
    assert.equal(representativeElementId(useViewerStore), 7, 'no wall: the first meshed element');
  });

  it('inspect selects an element when none is selected, so the Quantities tab exists', async () => {
    seedLoaded(loadedModel(0, [{ expressId: 12, ifcType: 'IfcWall' }]));
    useViewerStore.getState().clearSelection();
    await step(WELCOME_TOUR, 'inspect').prepare?.(useViewerStore);
    const s = useViewerStore.getState();
    assert.equal(s.selectedEntityId, 12);
    assert.equal(s.propertiesActiveTab, 'properties');
  });

  it('the tour drops its own selection when it ends, never the user\'s', async () => {
    seedLoaded(loadedModel(0, [{ expressId: 12, ifcType: 'IfcWall' }, { expressId: 30, ifcType: 'IfcDoor' }]));
    useViewerStore.getState().clearSelection();
    const inspect = step(WELCOME_TOUR, 'inspect');
    const ctx = { baseline: {}, artifacts: new Map() };
    await inspect.prepare?.(useViewerStore);
    assert.equal(useViewerStore.getState().selectedEntityId, 12);
    inspect.cleanup?.(useViewerStore, ctx);
    assert.equal(useViewerStore.getState().selectedEntityId, null, 'auto-selected wall cleared at tour end');

    await inspect.prepare?.(useViewerStore);
    useViewerStore.getState().setSelectedEntityId(30); // the user picks something else
    step(WELCOME_TOUR, 'wrap').cleanup?.(useViewerStore, ctx);
    assert.equal(useViewerStore.getState().selectedEntityId, 30, 'a selection the user made is theirs');
  });

  it('inspect keeps the element the user selected', async () => {
    seedLoaded(loadedModel(0, [{ expressId: 12, ifcType: 'IfcWall' }, { expressId: 30, ifcType: 'IfcDoor' }]));
    useViewerStore.getState().setSelectedEntityId(30);
    await step(WELCOME_TOUR, 'inspect').prepare?.(useViewerStore);
    assert.equal(useViewerStore.getState().selectedEntityId, 30);
  });
});

describe('ensureTourModel: welcome steps after a skipped load (#6720)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    useViewerStore.setState(originalState, true);
  });

  it('loads the demo project ONCE into an empty viewer and waits for it to settle', async () => {
    useViewerStore.setState({ models: new Map(), loading: false, geometryStreamingActive: false });
    globalThis.fetch = (async () => new Response('ISO-10303-21;')) as typeof fetch;
    const loaded: string[] = [];
    // Stand-in for useFileCommands' listener: the canonical load settles the store.
    const onLoad = (event: Event) => {
      loaded.push((event as CustomEvent<File>).detail.name);
      queueMicrotask(() => seedLoaded(loadedModel(0, [])));
    };
    window.addEventListener(EVENT_LOAD_FILE, onLoad);
    try {
      // The orbit step and the action button can overlap while the store still reads empty.
      await Promise.all([ensureTourModel(), ensureTourModel()]);
    } finally {
      window.removeEventListener(EVENT_LOAD_FILE, onLoad);
    }
    assert.deepEqual(loaded, ['building-architecture.ifc']);
    assert.equal(useViewerStore.getState().models.size, 1);
  });

  it('never swaps out a legacy single-model store either, and does not wait on it', async () => {
    useViewerStore.setState({ models: new Map(), ifcDataStore: fixtureModel('legacy').ifcDataStore, loading: false, geometryStreamingActive: false });
    let fetched = 0;
    globalThis.fetch = (async () => { fetched += 1; return new Response(''); }) as typeof fetch;
    await ensureTourModel();
    assert.equal(fetched, 0);
  });

  it('never swaps out a model that is already loaded', async () => {
    seedLoaded(loadedModel(0, []));
    let fetched = 0;
    globalThis.fetch = (async () => { fetched += 1; return new Response(''); }) as typeof fetch;
    await ensureTourModel();
    assert.equal(fetched, 0);
  });
});

describe('lens tour isolate-legend after a skipped apply (#6720)', () => {
  afterEach(() => { useViewerStore.setState(originalState, true); });

  it('applies the step\'s own lens so the legend renders', async () => {
    useViewerStore.setState({ activeLensId: null });
    await step(LENS_TOUR, 'isolate-legend').prepare?.(useViewerStore);
    assert.equal(useViewerStore.getState().activeLensId, 'lens-by-class');
  });

  it('keeps a lens the user applied', async () => {
    useViewerStore.setState({ activeLensId: 'lens-structural' });
    await step(LENS_TOUR, 'isolate-legend').prepare?.(useViewerStore);
    assert.equal(useViewerStore.getState().activeLensId, 'lens-structural');
  });
});

describe('ribbon tour without the open-view step (#6720: skipped 70 of 76)', () => {
  afterEach(() => { useViewerStore.setState(originalState, true); });

  it('the step after the tab strip opens the View band its anchors live in', async () => {
    const tabs = RIBBON_TOUR.steps.findIndex((s) => s.id === 'tabs');
    const next = RIBBON_TOUR.steps[tabs + 1];
    await step(RIBBON_TOUR, 'tabs').prepare?.(useViewerStore);
    assert.equal(useViewerStore.getState().ribbonTab, 'home');
    await next.prepare?.(useViewerStore);
    assert.equal(useViewerStore.getState().ribbonTab, 'view');
    assert.equal(next.gate, undefined, 'no action gate left between the tab strip and the View band');
  });
});
