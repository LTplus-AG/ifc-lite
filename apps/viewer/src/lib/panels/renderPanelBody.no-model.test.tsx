/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model-dependent panel opened on an empty viewer (#6720): field
 * replays show no-load sessions opening Lens, Charts, Zones, Presentation,
 * Lists and more and getting controls over nothing. Through the real
 * `renderPanelBody` (the one map every panel host uses), such a panel now
 * offers the sample model and the file picker, measured with id-only
 * `onboarding_surface` events, and steps aside the moment a model exists.
 */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore, type FederatedModel } from '@/store';
import { posthog } from '@/lib/analytics';
import { cleanup, click, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { EVENT_LOAD_FILE } from '@/lib/tours/events';
import { anchorSelector, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { renderPanelBody } from './renderPanelBody.js';

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

const NO_MODEL = 'Start with a model';
const BANNER = /results appear once one is loaded/;
const SAMPLE = 'Load demo project';
const OPEN = 'Open model file';

const empty = () => useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null, loading: false });
const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('renderPanelBody on an empty viewer (#6720)', () => {
  afterEach(() => {
    cleanup();
    mock.restoreAll();
    useViewerStore.setState(originalState, true);
  });

  it('a takeover panel offers the demo project and the picker instead of its controls', () => {
    empty();
    const root = render(renderPanelBody('lens', () => {}));
    assert.match(root.textContent ?? '', new RegExp(NO_MODEL));
    assert.ok(button(root, SAMPLE));
    assert.ok(button(root, OPEN));
    assert.doesNotMatch(root.textContent ?? '', /By IFC Class/i, 'the lens list is not shown over nothing');
  });

  it('the sample loads through the canonical load bus and the picker opens, each reported by id only', async () => {
    empty();
    const capture = mock.method(posthog, 'capture', () => undefined);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ISO-10303-21;')) as typeof fetch;
    const loaded: string[] = [];
    let pickerOpened = 0;
    const onLoad = (event: Event) => loaded.push((event as CustomEvent<File>).detail.name);
    const onOpen = () => { pickerOpened += 1; };
    window.addEventListener(EVENT_LOAD_FILE, onLoad);
    window.addEventListener('ifc-lite:open-files', onOpen);
    try {
      const root = render(renderPanelBody('charts', () => {}));
      await act(async () => { button(root, SAMPLE)!.click(); await new Promise((r) => setTimeout(r, 20)); });
      click(button(root, OPEN)!);
    } finally {
      window.removeEventListener(EVENT_LOAD_FILE, onLoad);
      window.removeEventListener('ifc-lite:open-files', onOpen);
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(loaded, ['building-architecture.ifc']);
    assert.equal(pickerOpened, 1);
    const onboarding = capture.mock.calls
      .filter((c) => c.arguments[0] === 'onboarding_surface')
      .map((c) => c.arguments[1]);
    assert.deepEqual(onboarding, [
      { surface: 'panel_empty_state', action: 'shown', panel_id: 'charts' },
      { surface: 'panel_empty_state', action: 'load_sample', panel_id: 'charts' },
      { surface: 'panel_empty_state', action: 'open_file', panel_id: 'charts' },
    ]);
  });

  it('a side panel keeps a working close; the bottom strip owns its own', () => {
    empty();
    let closed = 0;
    const side = render(renderPanelBody('environment', () => { closed += 1; }));
    click(side.querySelector('button[aria-label="Close panel"]')!);
    assert.equal(closed, 1);
    cleanup();
    const bottom = render(renderPanelBody('presentation', () => {}));
    assert.equal(bottom.querySelector('button[aria-label="Close panel"]'), null);
    cleanup();
    // The mobile sheet draws the panel title and close itself: one header, not two.
    useViewerStore.setState({ isMobile: true });
    const sheet = render(renderPanelBody('environment', () => {}));
    assert.equal(sheet.querySelector('button[aria-label="Close panel"]'), null);
    assert.match(sheet.textContent ?? '', new RegExp(NO_MODEL));
  });

  it('says what each takeover panel is for, not that it "works on a model"', () => {
    empty();
    const lens = render(renderPanelBody('lens', () => {}));
    assert.match(lens.textContent ?? '', /Load a model to apply a lens/);
    assert.doesNotMatch(lens.textContent ?? '', /works on a model/);
  });

  it('a banner panel keeps its model-independent content under the offer', () => {
    empty();
    const root = render(renderPanelBody('lists', () => {}));
    assert.match(root.textContent ?? '', BANNER);
    assert.ok(button(root, SAMPLE));
    assert.match(root.textContent ?? '', /New List/, 'list authoring stays reachable');
  });

  it('a banner panel is NOT remounted when a load starts or lands (#4243 class)', () => {
    empty();
    const root = render(renderPanelBody('lists', () => {}));
    const authored = button(root, 'New List');
    assert.ok(authored);
    act(() => { useViewerStore.setState({ loading: true }); });
    assert.doesNotMatch(root.textContent ?? '', BANNER, 'the line goes as soon as a load starts');
    assert.equal(button(root, 'New List'), authored, 'same DOM node: the panel kept its state');
    assert.ok(authored.isConnected);
    cleanup();
    // ... and through to the model landing (Zones mounts over the fixture store).
    empty();
    const zones = render(renderPanelBody('zones', () => {}));
    const importButton = zones.querySelector('button[aria-label="Import zone sets from JSON"]');
    assert.ok(importButton);
    act(() => { useViewerStore.setState({ loading: true }); });
    act(() => { useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), loading: false }); });
    assert.equal(zones.querySelector('button[aria-label="Import zone sets from JSON"]'), importButton);
    assert.ok(importButton.isConnected);
  });

  it('Gantt and Zones keep their model-free imports under a banner', () => {
    empty();
    const gantt = render(renderPanelBody('gantt', () => {}));
    assert.match(gantt.textContent ?? '', /import a schedule from MS Project or CSV now/);
    assert.doesNotMatch(gantt.textContent ?? '', new RegExp(NO_MODEL));
    cleanup();
    const zones = render(renderPanelBody('zones', () => {}));
    assert.match(zones.textContent ?? '', /import zone sets from JSON now/);
    assert.ok(zones.querySelector('button[aria-label="Import zone sets from JSON"]'), 'zone import stays reachable');
  });

  it('steps aside once a model exists or a load is under way', () => {
    useViewerStore.setState({ ...fixtureModels(fixtureModel('m')) });
    const withModel = render(renderPanelBody('lens', () => {}));
    assert.doesNotMatch(withModel.textContent ?? '', new RegExp(NO_MODEL));
    cleanup();
    useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null, loading: true });
    const loading = render(renderPanelBody('lists', () => {}));
    assert.doesNotMatch(loading.textContent ?? '', BANNER);
  });

  it('a panel that is itself a way in, or works without a model, is never gated', () => {
    empty();
    for (const id of ['bcf', 'validation', 'clash'] as const) {
      const root = render(renderPanelBody(id, () => {}));
      assert.doesNotMatch(root.textContent ?? '', new RegExp(NO_MODEL), id);
      cleanup();
    }
  });
});

describe('Information panel tour anchor (#6720: welcome/inspect broke)', () => {
  afterEach(() => {
    cleanup();
    useViewerStore.setState(originalState, true);
  });

  it('is present with no model and with a model but nothing selected', () => {
    empty();
    const none = render(renderPanelBody('properties', () => {}));
    assert.ok(none.querySelector(anchorSelector(TOUR_ANCHORS.propertiesPanel)), 'no model');
    cleanup();
    const model = { ...fixtureModel('m'), loadedAt: Date.now(), fileSize: 1024, schemaVersion: 'IFC4' } as FederatedModel;
    useViewerStore.setState({ ...fixtureModels(model), selectedEntityId: null, selectedEntity: null });
    const metadata = render(renderPanelBody('properties', () => {}));
    assert.ok(metadata.querySelector(anchorSelector(TOUR_ANCHORS.propertiesPanel)), 'model metadata branch');
    assert.equal(metadata.querySelectorAll(anchorSelector(TOUR_ANCHORS.propertiesPanel)).length, 1, 'one target');
  });
});
