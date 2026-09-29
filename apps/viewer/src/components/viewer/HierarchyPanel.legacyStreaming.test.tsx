/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6411: in legacy single-model mode (no registered models) the hierarchy
 * reads geometry from the top-level slot. While geometry streams, that slot
 * changes on every publish, and the class tree filters by it, so it refreshes
 * on the streaming cadence and is exact once streaming ends — the same rule
 * the registered-model path applies in its selector.
 */

import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { HierarchyPanel } from './HierarchyPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });

afterEach(() => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState({ geometryStreamingActive: false });
});

function geometry(ids: readonly number[]): GeometryResult {
  const meshes = ids.map((expressId) => ({
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  }) as MeshData);
  return { meshes, totalTriangles: ids.length, totalVertices: ids.length * 3 } as GeometryResult;
}

it('holds the legacy class tree while streaming and shows every element with geometry once streaming ends (#6411)', () => {
  let clock = 0;
  mock.method(performance, 'now', () => clock);
  const store = fixtureModel('legacy', {
    entities: [
      { expressId: 1, type: 'IfcWall', name: 'North wall' },
      { expressId: 2, type: 'IfcWall', name: 'South wall' },
    ],
  }).ifcDataStore;
  useViewerStore.setState({
    models: new Map(),
    ifcDataStore: store,
    geometryResult: geometry([1]),
    geometryStreamingActive: true,
    hierarchyMode: 'type',
    mutationViews: new Map(),
    mutationVersion: 0,
    georefMutations: new Map(),
  });
  const panel = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
  const text = () => panel.textContent ?? '';
  // Collapsed class groups carry their counts: one wall has geometry, the
  // other sits under "Other" until its mesh arrives (an icon glyph separates them).
  assert.match(text(), /IfcWall1\D*Other1/, 'initial');

  clock = 1;
  act(() => useViewerStore.setState({ geometryResult: geometry([1, 2]) }));
  assert.match(text(), /IfcWall1\D*Other1/, 'a publish within the refresh window is held');

  act(() => useViewerStore.setState({ geometryStreamingActive: false }));
  assert.match(text(), /IfcWall2/, 'streaming ended: both walls have geometry');
  assert.doesNotMatch(text(), /Other/);
});
