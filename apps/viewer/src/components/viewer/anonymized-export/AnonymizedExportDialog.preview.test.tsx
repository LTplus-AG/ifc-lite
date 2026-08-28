/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnonymizedExportDialog` 3D preview isolation (#2934): opening the dialog
 * with "Preview in 3D" on must isolate exactly the currently-included set
 * (via `usePreviewIsolation` -> `setIsolatedEntities`, global ids through
 * `toGlobalIdForRef` — never offset math, `idOffset: 1_000_000` catches a
 * hand-rolled version), shrink live as an item is unchecked, and restore the
 * viewer's PRIOR visibility state exactly on close.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { collectRelatedEntities } from '@ifc-lite/export';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { AnonymizedExportDialog } from './AnonymizedExportDialog.js';
import {
  parseFixtureModel,
  FIXTURE_WALL_A,
  FIXTURE_WALL_TYPE,
} from './anonymized-export-fixture.test-support.js';

const ID_OFFSET = 1_000_000;
const globalId = (localId: number): number => localId + ID_OFFSET;

function federatedModel(id: string, ifcDataStore: FederatedModel['ifcDataStore']): FederatedModel {
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
    idOffset: ID_OFFSET,
    maxExpressId: 100_000,
  } as FederatedModel;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
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

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Every checkbox row whose label text includes `needle`, excluding group headers. */
function itemCheckbox(needle: string): HTMLInputElement {
  const labels = [...document.body.querySelectorAll('label')];
  const label = labels.find((l) => l.textContent?.includes(needle) && l.querySelector('input[type="checkbox"]'));
  assert.ok(label, `no checkbox row for "${needle}"`);
  return label.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

beforeEach(async () => {
  unmountAll();
  const store = await parseFixtureModel();
  useViewerStore.setState({
    models: new Map([['m1', federatedModel('m1', store)]]),
    selectedEntity: { modelId: 'm1', expressId: FIXTURE_WALL_A },
    selectedEntityIds: new Set([globalId(FIXTURE_WALL_A)]),
    anonymizedExportRequested: false,
    // A prior 3D view state that is NOT the empty default, so "restored on
    // close" is provably a restore and not just "went back to nothing".
    isolatedEntities: new Set([globalId(9999)]),
    ghostExceptEntities: null,
    hiddenEntities: new Set([globalId(8888)]),
  });
});

describe('AnonymizedExportDialog — 3D preview isolation', () => {
  it('isolates exactly the included set on open, and shrinks when an item is unchecked', async () => {
    const store = useViewerStore.getState().models.get('m1')!.ifcDataStore!;
    const expectedAll = collectRelatedEntities(store, [FIXTURE_WALL_A]).all;
    const expectedGlobalIds = new Set([...expectedAll].map(globalId));

    render(<AnonymizedExportDialog />);
    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });

    assert.deepEqual(
      useViewerStore.getState().isolatedEntities,
      expectedGlobalIds,
      'preview must isolate exactly the currently-included set, converted through toGlobalIdForRef',
    );

    // Uncheck the wall type — a related, non-locked id.
    click(itemCheckbox('WallType Fixture'));
    const afterUncheck = useViewerStore.getState().isolatedEntities;
    assert.ok(afterUncheck, 'isolation must still be set');
    assert.equal(
      afterUncheck!.has(globalId(FIXTURE_WALL_TYPE)),
      false,
      'unchecking an item must shrink the live preview isolation',
    );
    assert.equal(afterUncheck!.size, expectedGlobalIds.size - 1);
  });

  it('restores the prior isolated/hidden/ghostExcept state exactly on close', () => {
    render(<AnonymizedExportDialog />);
    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });
    assert.notDeepEqual(useViewerStore.getState().isolatedEntities, new Set([globalId(9999)]), 'sanity: preview changed the isolation');

    const cancelButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel');
    assert.ok(cancelButton, 'no Cancel button');
    click(cancelButton);

    const after = useViewerStore.getState();
    assert.deepEqual(after.isolatedEntities, new Set([globalId(9999)]), 'isolatedEntities must be restored');
    assert.deepEqual(after.ghostExceptEntities, null, 'ghostExceptEntities must be restored');
    assert.deepEqual(after.hiddenEntities, new Set([globalId(8888)]), 'hiddenEntities must be restored');
  });
});
