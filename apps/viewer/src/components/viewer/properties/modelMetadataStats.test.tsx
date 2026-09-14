/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Production-observing coverage for the ModelMetadataPanel statistics row.
 * The fixture has seven physical elements, but #3 has no representation.
 */

import '@/test/setup-dom.js';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { federationRegistry } from '@ifc-lite/renderer';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types.js';
import { ModelMetadataPanel } from './ModelMetadataPanel.js';

const TYPES = new Map<number, string>([
  [1, 'IFCWALL'],
  [2, 'IFCBUILDINGELEMENTPROXY'],
  [3, 'IFCBUILDINGELEMENTPROXY'],
  [4, 'IFCSLAB'],
  [5, 'IFCDOOR'],
  [6, 'IFCWINDOW'],
  [7, 'IFCCOLUMN'],
]);
const BY_TYPE = new Map<string, number[]>();
for (const [id, type] of TYPES) BY_TYPE.set(type, [...(BY_TYPE.get(type) ?? []), id]);

function dataStore(): IfcDataStore {
  return {
    spatialHierarchy: { byStorey: new Map([[100, [...TYPES.keys()]]]) },
    entityIndex: { byType: BY_TYPE },
    entities: {
      getName: () => undefined,
      getGlobalId: () => undefined,
      getDescription: () => undefined,
    },
    relationships: undefined,
  } as unknown as IfcDataStore;
}

function model(overrides: Partial<FederatedModel> = {}): FederatedModel {
  return {
    id: 'stats-model',
    name: 'stats.ifc',
    ifcDataStore: dataStore(),
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset: federationRegistry.getOffset('stats-model') ?? 0,
    maxExpressId: 100,
    ...overrides,
  } as FederatedModel;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(subject: FederatedModel): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ModelMetadataPanel model={subject} />));
  mounted.push({ root, container });
  return container;
}

function statistic(container: HTMLElement, label: string): string | undefined {
  const row = [...container.querySelectorAll('div')].find((element) =>
    [...element.children].some((child) => child.textContent === label),
  );
  return row?.lastElementChild?.textContent ?? undefined;
}

function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

beforeEach(() => {
  unmountAll();
  federationRegistry.clear();
  federationRegistry.registerModel('other-model', 100);
  federationRegistry.registerModel('stats-model', 100);
});

after(() => {
  unmountAll();
  federationRegistry.clear();
});

describe('ModelMetadataPanel — Elements with Geometry', () => {
  it('counts shaped physical elements using canonical federated ID resolution', () => {
    const offset = federationRegistry.getOffset('stats-model') ?? 0;
    const geometryResult = {
      meshes: [1, 2, 4, 5, 6].map((expressId) => ({ expressId: expressId + offset })),
      instancedGeometryHashes: new Map([[7 + offset, 0n]]),
    } as never;
    const container = render(model({ geometryResult, idOffset: offset, loadState: 'complete' }));
    assert.equal(statistic(container, 'Elements with Geometry'), '6');
  });

  it('treats completed null geometry as known-empty', () => {
    const container = render(model({ geometryResult: null, loadState: 'complete' }));
    assert.equal(statistic(container, 'Elements with Geometry'), '0');
  });

  it('keeps the shape filter provisional while geometry is streaming', () => {
    const container = render(model({ geometryResult: null, loadState: 'streaming-geometry' }));
    assert.equal(statistic(container, 'Elements with Geometry'), '7');
  });
});
