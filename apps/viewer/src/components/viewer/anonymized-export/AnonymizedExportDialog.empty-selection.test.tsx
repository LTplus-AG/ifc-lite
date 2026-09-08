/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnonymizedExportDialog` — empty selection and cross-model selection
 * (#2934): with nothing selected the dialog hints instead of rendering an
 * empty toggle/list UI, and Export stays disabled; with a selection spread
 * across two models it targets the primary model and reports how many
 * selected objects in other models were not included.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { AnonymizedExportDialog } from './AnonymizedExportDialog.js';
import { parseFixtureModel, FIXTURE_WALL_A, FIXTURE_WALL_B } from './anonymized-export-fixture.test-support.js';

const ID_OFFSET = 1_000_000;

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

function exportButton(): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Export .ifc'));
  assert.ok(btn, 'no Export .ifc button');
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  unmountAll();
  useViewerStore.setState({
    models: new Map(),
    selectedEntity: null,
    selectedEntityIds: new Set(),
    anonymizedExportRequested: false,
    isolatedEntities: null,
    ghostExceptEntities: null,
    hiddenEntities: new Set(),
  });
});

describe('AnonymizedExportDialog — empty selection', () => {
  it('hints instead of a toggle/result UI, and Export stays disabled', async () => {
    const store = await parseFixtureModel();
    useViewerStore.setState({ models: new Map([['m1', federatedModel('m1', store)]]) });

    render(<AnonymizedExportDialog />);
    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });

    assert.match(
      document.body.textContent ?? '',
      /select one or more objects/i,
      'an empty selection must hint rather than render an empty result UI',
    );
    assert.equal(document.body.textContent?.includes('Expand with related'), false, 'no toggle panel with nothing to expand');
    assert.equal(exportButton().disabled, true, 'Export must be disabled with nothing selected');
  });

  it('a selection spread across two models targets the primary and reports the rest', async () => {
    const storeA = await parseFixtureModel();
    const storeB = await parseFixtureModel();
    useViewerStore.setState({
      models: new Map([
        ['m1', federatedModel('m1', storeA, 0)],
        ['m2', federatedModel('m2', storeB, 2_000_000)],
      ]),
      selectedEntity: { modelId: 'm1', expressId: FIXTURE_WALL_A },
      selectedEntityIds: new Set([FIXTURE_WALL_A, 2_000_000 + FIXTURE_WALL_B]),
    });

    render(<AnonymizedExportDialog />);
    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });

    assert.match(
      document.body.textContent ?? '',
      /1 selected object.*in other models not included/i,
      'the other model\'s seed must be reported, not silently merged in',
    );
    assert.equal(exportButton().disabled, false, 'the primary model\'s own selection is still exportable');
  });
});
