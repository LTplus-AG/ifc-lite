/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `selectedStoreys` in the viewer store is a bare `Set<number>` of
 * model-LOCAL expressIds — the pairing with each storey's owning model,
 * which `treeDataBuilder` maintains on every tree node as `modelIds`
 * (index-aligned with `expressIds`), is discarded once the ids land in the
 * set (see #3506, #3508).
 *
 * `HierarchyPanel`'s `computeNodeState` reads that set back for
 * `unified-storey` rows with `node.expressIds.some(id => selectedStoreys.has(id))`
 * — no `modelId` check. `buildUnifiedStoreys` (treeDataBuilder.ts) groups
 * storeys into separate unified rows purely by ELEVATION, independent of id
 * collisions across models, so two different federated models can each
 * contribute a storey with the same local expressId to two DIFFERENT
 * unified-storey rows (routine: most IFC files number entities from #1).
 *
 * This test federates two models whose storeys share the local expressId 5
 * at two different elevations — "Level 1" (model m1, id 5, elevation 0) and
 * "Level 2" (model m2, id 5, elevation 10) — selects only Level 1, and
 * checks whether Level 2's row lights up too.
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
    idOffset: 0,
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

    // Click Level 1 — the real click path (handleNodeClick) writes its
    // constituent local storey id (5, from model m1) into selectedStoreys.
    act(() => { level1.click(); });

    assert.deepEqual(
      useViewerStore.getState().selectedStoreys,
      new Set([5]),
      'fixture sanity: clicking Level 1 must select local id 5',
    );

    const level1After = storeyRow(container, 'Level 1');
    const level2After = storeyRow(container, 'Level 2');

    assert.ok(
      level1After.classList.contains('selected'),
      'Level 1 (the row actually clicked) must be highlighted',
    );
    assert.ok(
      !level2After.classList.contains('selected'),
      'Level 2 (model m2\'s own unrelated storey, which merely SHARES the local expressId 5 with model m1\'s Level 1) ' +
      'must NOT be highlighted — computeNodeState must check modelIds, not just expressIds, against selectedStoreys',
    );
  });
});
