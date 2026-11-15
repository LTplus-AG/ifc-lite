/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10214: a `.3dm` layer row's eye acts on its sub-layers as Rhino does.
 * Driven with the real payload of a crafted `.3dm` (layers under a layer that
 * is off), through the panel's own eye button.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { craftRhinoNestedOffLayers, rhinoPayloadOf } from '@/test/rhino-3dm-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import type { IfcDataStore } from '@ifc-lite/parser';
import { HierarchyPanel } from './HierarchyPanel.js';

// The tree is virtualized; happy-dom reports no layout (pattern from HierarchyPanel.removeModel.test.tsx).
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 400 });

let store: IfcDataStore;
const hiddenNames = () => [...useViewerStore.getState().hiddenEntities].map((id) => store.entities.getName(id)).sort();

function eye(container: HTMLElement, verb: 'Show' | 'Hide', name: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${verb} ${name}"]`);
  assert.ok(button, `a ${verb} button on the ${name} row`);
  return button;
}

describe('HierarchyPanel: a .3dm layer row hides and shows its sub-layers (#10214)', () => {
  beforeEach(async () => {
    const payload = await rhinoPayloadOf(await craftRhinoNestedOffLayers(), 'layers.3dm');
    store = payload.dataStore;
    const model = { ...fixtureModel('rhino'), ifcDataStore: store, containerVisibility: payload.containerVisibility };
    useViewerStore.setState({ ...fixtureModels(model), hiddenEntities: new Set(payload.hiddenExpressIds) });
  });

  afterEach(() => cleanup());

  it('shows the sub-layers that are on with the parent, and hides them all with it', () => {
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    assert.deepEqual(hiddenNames(), ['Beam', 'Bolt', 'Bolts', 'Brace', 'Bracing', 'Column', 'Columns', 'Frame', 'Spare beam']);

    click(eye(container, 'Show', 'Frame'));
    // Rhino keeps the sub-layer that is off itself, and the beam hidden on its own, hidden.
    assert.deepEqual(hiddenNames(), ['Brace', 'Bracing', 'Spare beam']);

    click(eye(container, 'Hide', 'Frame'));
    assert.deepEqual(hiddenNames(), ['Beam', 'Bolt', 'Bolts', 'Brace', 'Bracing', 'Column', 'Columns', 'Frame', 'Spare beam']);
  });

  it('keeps what the user turned on or off in a sub-layer when the parent is toggled, as Rhino does', () => {
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    click(eye(container, 'Show', 'Frame'));
    // Turn the sub-layer that was off on, and the one that was on off.
    click(eye(container, 'Show', 'Bracing'));
    click(eye(container, 'Hide', 'Columns'));
    assert.deepEqual(hiddenNames(), ['Bolt', 'Bolts', 'Column', 'Columns', 'Spare beam']);

    click(eye(container, 'Hide', 'Frame'));
    click(eye(container, 'Show', 'Frame'));
    assert.deepEqual(hiddenNames(), ['Bolt', 'Bolts', 'Column', 'Columns', 'Spare beam']);
  });

  it('clears a multi-selection inside a sub-layer the parent hides', () => {
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    click(eye(container, 'Show', 'Frame'));
    const column = [...store.entities.expressId].find((id) => store.entities.getName(id) === 'Column')!;
    const beam = [...store.entities.expressId].find((id) => store.entities.getName(id) === 'Beam')!;
    useViewerStore.setState({ selectedEntityId: null, selectedEntityIds: new Set([column, beam]) });
    click(eye(container, 'Hide', 'Frame'));
    assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);
  });

  it('hides and shows the whole file from the root row', () => {
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    click(eye(container, 'Hide', 'layers.3dm'));
    assert.ok(hiddenNames().includes('Terrain'), 'the root row stands for the file');
    // The root holds no object directly; it still reads as hidden once nothing under it is drawn.
    assert.ok(eye(container, 'Show', 'layers.3dm').closest('[class*="grayscale"]'), 'the root row is styled hidden');
    click(eye(container, 'Show', 'layers.3dm'));
    // Site is on; Frame is off itself, so its subtree stays as Rhino had it.
    assert.deepEqual(hiddenNames(), ['Beam', 'Bolt', 'Bolts', 'Brace', 'Bracing', 'Column', 'Columns', 'Frame', 'Spare beam']);
  });
});
