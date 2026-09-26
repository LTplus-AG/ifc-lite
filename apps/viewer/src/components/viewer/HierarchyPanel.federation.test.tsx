/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5885: hierarchy row activation selects renderer global IDs and model-aware
 * EntityRefs without touching the Solo storey channel. Equal local express
 * IDs in two federated models remain distinct selections; the explicit Solo
 * action still uses the shared storey-isolation channel (#3506/#3508).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { activate, press } from '@/test/render.js';
import { HierarchyPanel } from './HierarchyPanel.js';

// `@tanstack/react-virtual` measures the scroll container's real
// `offsetHeight` to decide which rows are in the visible range; happy-dom
// (no real layout engine) always reports 0, so with no stub every
// virtualized row silently fails to render. Give it a plausible viewport
// once, globally (pattern from ClashPanel.test.tsx).
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });

/** Minimal stub `IfcDataStore` carrying just the fields `buildUnifiedStoreys`
 *  and `buildTreeData`'s MODELS section read: one storey at `storeyId`. */
function makeStore(storeyId: number, elevation: number, name: string): IfcDataStore {
  return {
    entityCount: 1,
    spatialHierarchy: {
      project: undefined,
      byStorey: new Map([[storeyId, []]]),
      storeyElevations: new Map([[storeyId, elevation]]),
    },
    entities: {
      getName: (id: number) => (id === storeyId ? name : undefined),
    },
  } as unknown as IfcDataStore;
}

function federatedModel(id: string, ifcDataStore: IfcDataStore): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset: id === 'm2' ? 1000 : 0,
    maxExpressId: 100,
  } as FederatedModel;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderPanel(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SourceHostProvider>
        <TooltipProvider>
          <HierarchyPanel />
        </TooltipProvider>
      </SourceHostProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

function resetStore(): void {
  useViewerStore.setState({
    models: new Map(),
    ifcDataStore: null,
    selectedStoreys: new Set<number>(),
    selectedEntityIds: new Set<number>(),
    selectedEntityId: null,
    selectedEntity: null,
    selectedEntitiesSet: new Set<string>(),
    levelDisplayMode: 'stacked',
  });
}

/** Find the top-level unified-storey row by its visible label text. */
function storeyRow(container: HTMLElement, label: string): HTMLElement {
  const items = [...container.querySelectorAll<HTMLElement>('.hierarchy-item')];
  const row = items.find((el) => el.textContent?.includes(label));
  assert.ok(row, `expected a hierarchy row labelled "${label}"; got rows: ${items.map(i => i.textContent).join(' | ')}`);
  return row;
}

describe('HierarchyPanel — federated unified-storey selection', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    unmountAll();
    resetStore();
  });

  it('distinguishes pending IFC metadata from completed geometry-only models (#3984)', () => {
    const model = federatedModel('m1', makeStore(5, 0, 'Level 1'));
    model.ifcDataStore = null;
    model.loadState = 'hydrating-metadata';
    useViewerStore.setState({ models: new Map([['m1', model]]) });
    const container = renderPanel();
    assert.match(container.textContent ?? '', /Building the hierarchy/);
    act(() => {
      useViewerStore.setState({ models: new Map([['m1', { ...model, loadState: 'complete' }]]) });
    });
    assert.match(container.textContent ?? '', /No hierarchy available for this model/);
    assert.doesNotMatch(container.textContent ?? '', /Building the hierarchy/);
  });

  it('a tagged model row is taller and carries its chips on a second line; an untagged row keeps the base height (#4215)', () => {
    // At the panel's default width the name, count and actions already fill a
    // model row (seen in a real two-model session): chips beside them squeezed
    // the name to nothing. The Models virtualizer sizes tagged rows for a chips line.
    useViewerStore.setState({
      models: new Map([['m1', federatedModel('m1', makeStore(5, 0, 'Level 1'))], ['m2', federatedModel('m2', makeStore(5, 10, 'Level 2'))]]),
      modelTags: new Map(),
      modelTagAssignments: new Map(),
    });
    const s = useViewerStore.getState();
    const structure = s.createModelTag('Structure')!;
    const tender = s.createModelTag('Tender')!;
    s.assignModelTags(['m1'], [structure, tender]);
    const container = renderPanel();
    const rowHeight = (modelId: string) =>
      container.querySelector<HTMLElement>(`button[aria-label="Edit tags for model ${modelId}.ifc"]`)!.closest<HTMLElement>('div[style*="translateY"]')!.style.height;
    assert.equal(rowHeight('m1'), '54px');
    assert.equal(rowHeight('m2'), '36px');
    assert.equal(container.querySelector('[data-model-row-tags="m1"]')?.getAttribute('title'), 'Structure, Tender');
    act(() => { useViewerStore.getState().unassignModelTags(['m1'], [structure, tender]); });
    assert.equal(rowHeight('m1'), '36px', 'losing its tags gives the row its base height back');
  });

  it('selecting Level 1 (model m1, local id 5) does not cross-highlight Level 2 (model m2, same local id 5)', () => {
    const m1 = federatedModel('m1', makeStore(5, 0, 'Level 1'));
    const m2 = federatedModel('m2', makeStore(5, 10, 'Level 2'));
    useViewerStore.setState({
      models: new Map([['m1', m1], ['m2', m2]]),
    });

    const container = renderPanel();

    // Sanity: two distinct unified-storey rows exist, one per elevation.
    const level1 = storeyRow(container, 'Level 1');
    const level2 = storeyRow(container, 'Level 2');
    assert.notEqual(level1, level2, 'fixture sanity: Level 1 and Level 2 must be different rows');

    // #5885: a row click selects its IFC entity, without entering Solo or
    // changing the Advanced Filter. Distinct model offsets keep ids separate.
    act(() => { level1.click(); });

    assert.deepEqual(
      useViewerStore.getState().selectedEntityIds,
      new Set([5]),
      'clicking Level 1 selects model m1 storey entity',
    );
    assert.deepEqual(useViewerStore.getState().selectedStoreys, new Set());
    assert.equal(useViewerStore.getState().levelDisplayMode, 'stacked');

    const level1After = storeyRow(container, 'Level 1');
    const level2After = storeyRow(container, 'Level 2');

    assert.ok(
      level1After.classList.contains('selected'),
      'Level 1 (the row actually clicked) must be highlighted',
    );
    assert.ok(
      !level2After.classList.contains('selected'),
      'Level 2 (model m2\'s own unrelated storey, which merely SHARES the local expressId 5 with model m1\'s Level 1) ' +
      'must NOT be highlighted — renderer global IDs preserve model ownership',
    );
  });

  it('activates hierarchy rows and model headers with Enter and Space (#5823)', () => {
    useViewerStore.setState({
      models: new Map([
        ['m1', federatedModel('m1', makeStore(5, 0, 'Level 1'))],
        ['m2', federatedModel('m2', makeStore(6, 10, 'Level 2'))],
      ]),
    });
    const container = renderPanel();
    const level1 = storeyRow(container, 'Level 1');
    assert.equal(level1.getAttribute('role'), 'treeitem');
    activate(level1, 'Enter');
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([5]));
    assert.deepEqual(useViewerStore.getState().selectedStoreys, new Set());

    const level2 = storeyRow(container, 'Level 2');
    activate(level2, ' ');
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([1006]));
    assert.deepEqual(useViewerStore.getState().selectedStoreys, new Set());

    const solo = container.querySelector<HTMLButtonElement>('button[aria-label="Solo storey Level 1"]');
    assert.ok(solo);
    act(() => { solo.click(); });
    assert.deepEqual(useViewerStore.getState().selectedStoreys, new Set([5]));
    assert.equal(useViewerStore.getState().levelDisplayMode, 'solo');

    const modelRow = container.querySelector<HTMLElement>('button[aria-label="Edit tags for model m1.ifc"]')
      ?.closest<HTMLElement>('[role="treeitem"]');
    assert.ok(modelRow, 'model header should be a focusable tree item');
    activate(modelRow, 'Enter');
    assert.equal(useViewerStore.getState().selectedModelId, 'm1');
    const secondModelRow = container.querySelector<HTMLElement>('button[aria-label="Edit tags for model m2.ifc"]')
      ?.closest<HTMLElement>('[role="treeitem"]');
    assert.ok(secondModelRow);
    activate(secondModelRow, ' ');
    assert.equal(useViewerStore.getState().selectedModelId, 'm2');
  });

  it('Ctrl/Cmd toggles and Shift extends storey entity selection across models (#5885)', () => {
    useViewerStore.setState({
      models: new Map([
        ['m1', federatedModel('m1', makeStore(5, 0, 'Level 1'))],
        ['m2', federatedModel('m2', makeStore(6, 10, 'Level 2'))],
      ]),
    });
    const container = renderPanel();
    act(() => { storeyRow(container, 'Level 1').click(); });
    act(() => {
      storeyRow(container, 'Level 2').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([5, 1006]));
    act(() => {
      storeyRow(container, 'Level 1').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    });
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([1006]));
    act(() => { storeyRow(container, 'Level 1').click(); });
    act(() => {
      storeyRow(container, 'Level 2').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([5, 1006]));
    assert.deepEqual(useViewerStore.getState().selectedStoreys, new Set());
  });

  it('resizes the storeys and models split with arrow keys (#5823)', () => {
    useViewerStore.setState({
      models: new Map([
        ['m1', federatedModel('m1', makeStore(5, 0, 'Level 1'))],
        ['m2', federatedModel('m2', makeStore(6, 10, 'Level 2'))],
      ]),
    });
    const container = renderPanel();
    const divider = container.querySelector<HTMLElement>('[role="separator"][aria-orientation="horizontal"]');
    assert.ok(divider);
    assert.equal(divider.getAttribute('aria-valuenow'), '50');
    const storeysSection = divider.previousElementSibling as HTMLElement;
    press(divider, 'ArrowDown');
    assert.equal(divider.getAttribute('aria-valuenow'), '55');
    assert.ok(Math.abs(parseFloat(storeysSection.style.height) - 55) < 0.001);
    press(divider, 'Home');
    assert.equal(divider.getAttribute('aria-valuenow'), '15');
    press(divider, 'End');
    assert.equal(divider.getAttribute('aria-valuenow'), '85');
  });
});
