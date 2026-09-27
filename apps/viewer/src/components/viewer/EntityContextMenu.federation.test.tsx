/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `EntityContextMenu`'s "Select all <Type>" and "Select same storey" items
 * read `activeDataStore.entities` / `spatialHierarchy`, both model-space
 * (the right-clicked entity's OWN store), but must write their result into
 * `selectedEntityIds` — the renderer-space, offset-per-model channel every
 * other consumer (picking, `resolveEntityRef`, the renderer) treats as a
 * `globalId`. With a non-zero federation offset, writing the raw model-space
 * ids selects the WRONG entities (or none) once a second model is loaded.
 *
 * Uses the same federated single-model-with-offset fixture as
 * `EntityContextMenu.anonymized-export.test.tsx`.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { EntityContextMenu } from './EntityContextMenu.js';
import { surfaceCommand, SURFACE_COMMANDS } from './surface-commands.js';
import { DUPLICATE_CONTEXT_DIRECTIONS } from './surface-commands-context.js';
import { resolveEnglish } from '@/i18n/registry.js';
import {
  parseFixtureModel,
  FIXTURE_WALL_A,
  FIXTURE_WALL_B,
  FIXTURE_WALL_C,
} from './anonymized-export/anonymized-export-fixture.test-support.js';

const ID_OFFSET = 1_000_000;
const globalId = (localId: number): number => localId + ID_OFFSET;

function federatedModel(id: string, ifcDataStore: FederatedModel['ifcDataStore'], idOffset = ID_OFFSET): FederatedModel {
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
    idOffset,
    maxExpressId: 100_000,
  } as FederatedModel;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<EntityContextMenu />); });
  mounted.push({ root, container });
  return container;
}
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}
after(unmountAll);

function menuItem(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) =>
    b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
  assert.ok(btn, `no menu item labelled "${label}"`);
  return btn as HTMLButtonElement;
}

beforeEach(async () => {
  unmountAll();
  const store = await parseFixtureModel();
  useViewerStore.setState({
    models: new Map([['m1', federatedModel('m1', store)]]),
    selectedEntityIds: new Set<number>(),
    anonymizedExportRequested: false,
    mutationViews: new Map(),
    storeEditors: new Map(),
    undoStacks: new Map(),
    dirtyModels: new Set(),
    collabRole: null,
    editEnabled: false,
  });
});

describe('EntityContextMenu — federation-space selection', () => {
  it('renders the literal entity and canvas context registry matrix (#5870)', () => {
    useViewerStore.setState({ editEnabled: true });
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();
    const directions = new Set<string>(DUPLICATE_CONTEXT_DIRECTIONS.map((item) => item.id));
    const entityIds = SURFACE_COMMANDS.filter((command) =>
      command.surfaces.some((surface) => surface === 'context')
      && command.id !== 'vis:show' && !directions.has(command.id)).map((command) => command.id);
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-command-id]')];
    assert.deepEqual(new Set(rows.map((row) => row.dataset.commandId)), new Set(entityIds),
      'every entity-context declaration is mounted, without an extra undeclared row');
    for (const id of entityIds) {
      const definition = surfaceCommand(id, 'context');
      const row = rows.find((item) => item.dataset.commandId === id);
      assert.ok(row, `${id} has a mounted context-menu action`);
      assert.equal(row.getAttribute('aria-label'), resolveEnglish(definition.contextLabelKey ?? definition.labelKey,
        definition.contextLabelParams?.({ canEditInSession: false, contextEntityType: 'IfcWall' })),
      `${id} uses its registered label`);
    }

    const directionTrigger = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes(resolveEnglish('entityContextMenu.duplicateDirectionLabel')));
    assert.ok(directionTrigger);
    act(() => { directionTrigger.click(); });
    const directionRows = [...document.querySelectorAll<HTMLButtonElement>('[data-command-id^="context:duplicate-"]')];
    assert.deepEqual(new Set(directionRows.map((row) => row.dataset.commandId)), directions,
      'the directional submenu renders every registered direction');
    for (const row of directionRows) {
      const definition = SURFACE_COMMANDS.find((command) => command.id === row.dataset.commandId);
      assert.ok(definition);
      assert.equal(row.getAttribute('aria-label'), resolveEnglish(definition.labelKey));
    }

    act(() => { useViewerStore.getState().closeContextMenu(); });
    act(() => { useViewerStore.getState().openContextMenu(null, 10, 10); });
    const canvasRows = [...container.querySelectorAll<HTMLButtonElement>('[data-command-id]')];
    assert.deepEqual(new Set(canvasRows.map((row) => row.dataset.commandId)), new Set(['vis:show']),
      'the canvas context renders its one registered command');
    assert.equal(canvasRows[0]?.getAttribute('aria-label'), resolveEnglish(surfaceCommand('vis:show', 'context').labelKey));
  });

  for (const twoModels of [false, true]) {
    it(`disables Delete and Duplicate until Edit mode is on, then deletes only the target ${twoModels ? 'federated' : 'single'} model (#5901)`, async () => {
      if (twoModels) {
        const store = await parseFixtureModel();
        useViewerStore.setState({ models: new Map([
          ['m0', federatedModel('m0', store, 0)],
          ['m1', federatedModel('m1', store)],
        ]) });
      }
      act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
      const container = render();
      const deleteButton = menuItem(container, 'Delete entity');
      const duplicateButton = menuItem(container, 'Duplicate');
      assert.equal(deleteButton.disabled, true);
      assert.equal(duplicateButton.disabled, true);
      assert.match(deleteButton.title, /Turn on Edit mode/);
      assert.equal(useViewerStore.getState().mutationViews.size, 0);

      act(() => { useViewerStore.setState({ editEnabled: true }); });
      assert.equal(menuItem(container, 'Delete entity').disabled, false);
      assert.equal(menuItem(container, 'Duplicate').disabled, false);
      assert.ok(useViewerStore.getState().mutationViews.has('m1'));
      act(() => { menuItem(container, 'Delete entity').click(); });
      assert.equal(useViewerStore.getState().mutationViews.get('m1')?.isDeleted(FIXTURE_WALL_A), true);
      assert.equal(useViewerStore.getState().dirtyModels.has('m1'), true);
      if (twoModels) assert.equal(useViewerStore.getState().mutationViews.has('m0'), false);
    });

    it(`duplicates an authored IFC wall only after Edit mode is enabled in ${twoModels ? 'federated' : 'single'} mode (#5901)`, async () => {
      const bytes = await readFile(new URL('../../../public/samples/hello-wall.ifc', import.meta.url));
      const dataStore = await new IfcParser().parseColumnar(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        { disableWorkerScan: true },
      );
      const target = federatedModel('m1', dataStore);
      const otherStore = useViewerStore.getState().models.get('m1')!.ifcDataStore;
      const models = twoModels
        ? new Map([['m0', federatedModel('m0', otherStore, 0)], ['m1', target]])
        : new Map([['m1', target]]);
      useViewerStore.setState({ models, mutationViews: new Map(), undoStacks: new Map(), dirtyModels: new Set() });
      act(() => { useViewerStore.getState().openContextMenu(globalId(1222), 10, 10); });
      const container = render();
      assert.equal(menuItem(container, 'Duplicate').disabled, true);
      assert.equal(useViewerStore.getState().undoStacks.size, 0);

      act(() => { useViewerStore.setState({ editEnabled: true }); });
      assert.equal(menuItem(container, 'Duplicate').disabled, false);
      act(() => { menuItem(container, 'Duplicate').click(); });
      const duplicate = useViewerStore.getState().undoStacks.get('m1')?.at(-1);
      assert.equal(duplicate?.type, 'CREATE_ENTITY', 'Duplicate must record a new entity through the menu');
      assert.notEqual(duplicate?.entityId, 1222);
      assert.equal(useViewerStore.getState().dirtyModels.has('m1'), true);
      if (twoModels) assert.equal(useViewerStore.getState().undoStacks.has('m0'), false);
    });
  }

  it('"Select all IfcWall" resolves through the model offset', () => {
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();

    act(() => { menuItem(container, 'Select all IfcWall').click(); });

    const state = useViewerStore.getState();
    assert.deepEqual(
      state.selectedEntityIds,
      new Set([globalId(FIXTURE_WALL_A), globalId(FIXTURE_WALL_B), globalId(FIXTURE_WALL_C)]),
      'selectedEntityIds must carry renderer-space (offset) ids, not raw model-space expressIds',
    );
  });

  it('"Select same storey" resolves through the model offset', () => {
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_B), 10, 10); });
    const container = render();

    act(() => { menuItem(container, 'Select same storey').click(); });

    const state = useViewerStore.getState();
    assert.deepEqual(
      state.selectedEntityIds,
      new Set([globalId(FIXTURE_WALL_B), globalId(FIXTURE_WALL_C)]),
      'selectedEntityIds must carry renderer-space (offset) ids, not raw model-space expressIds',
    );
  });
});
