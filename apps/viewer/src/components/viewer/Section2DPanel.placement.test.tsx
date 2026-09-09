/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { Section2DPanel } from './Section2DPanel';

it('does not map the model mesh collection on placement previews while the drawing panel is closed (#4226)', () => {
  let maps = 0;
  const meshes: GeometryResult['meshes'] = [{ expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }];
  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = { meshes: new Proxy(meshes, { get(target, property, receiver) {
    if (property === 'map') maps++; return Reflect.get(target, property, receiver);
  } }), totalTriangles: 1, totalVertices: 3, coordinateInfo: {
    originShift: zero, originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, hasLargeCoordinates: false } };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), geometryResult: geometry }), modelPlacement: emptyPlacementState(),
    drawing2DPanelVisible: false, activeModelId: null, ifcDataStore: null, activeTool: 'select' });
  try {
    const ui = render(<Section2DPanel mergedGeometry={geometry} />);
    const initialMaps = maps;
    act(() => { const s = useViewerStore.getState(); s.openReposition(['m']); s.previewModelTranslation([100, 0, 0]); });
    assert.equal(ui.textContent, ''); assert.equal(maps, initialMaps, 'a hidden drawing panel does no placement mesh mapping');
  } finally { cleanup(); }
});
