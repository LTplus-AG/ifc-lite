/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Floor plan above the model top (#8162). `activateFloorplan` used to clamp
 * floor + 1.2 m to the merged Y range, so a top storey whose cut clears the
 * model top was cut on the top face instead. It now stores a position past
 * 100 % that resolves to floor + 1.2 m, while a floor outside the range keeps
 * the clamped fallback. The store keeps a percentage, so a later bounds change
 * moves the cut the way it moves any percentage cut, and activating the floor
 * plan again recomputes floor + 1.2 m against the new bounds.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import type { SectionStorey } from '@/lib/section/section-distance';
import { useFloorplanView } from './useFloorplanView.js';

function bounded(id: string, maxY: number): FederatedModel {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: maxY, z: 8 } };
  const geometryResult: GeometryResult = {
    meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: box, shiftedBounds: box, hasLargeCoordinates: false },
  };
  return { ...fixtureModel(id), geometryResult };
}

let activate: ((storey: SectionStorey) => void) | null = null;
function Probe(): null {
  activate = useFloorplanView().activateFloorplan;
  return null;
}

const s = () => useViewerStore.getState();
const top: SectionStorey = { expressId: 11, modelId: 'a', name: 'Top', elevation: 2.5 };
/** The stored cut resolved against a [0, maxY] Y range, the way the renderer and drawing read it. */
const cutY = (maxY: number) => (s().sectionPlane.position / 100) * maxY;

function load(...models: FederatedModel[]): void {
  act(() => useViewerStore.setState({ models: new Map(models.map((m) => [m.id, m])), geometryResult: null, ifcDataStore: null }));
}

beforeEach(() => {
  useViewerStore.setState({
    activeTool: 'select', drawing2DPanelVisible: false,
    sectionPlane: { ...s().sectionPlane, axis: 'front', position: 10, enabled: false, parked: false, custom: undefined },
  });
  load(bounded('a', 3));
  render(<Probe />);
  assert.ok(activate, 'the hook returned activateFloorplan');
});
afterEach(() => { cleanup(); activate = null; });

it('a top storey at 2.5 m under a 3 m model top cuts at 3.7 m (> 100 %), not on the top face', () => {
  act(() => activate!(top));
  assert.equal(s().sectionPlane.axis, 'down');
  assert.ok(s().sectionPlane.position > 100, `position ${s().sectionPlane.position} must exceed 100`);
  assert.ok(Math.abs(cutY(3) - 3.7) < 1e-9, `the cut resolves to ${cutY(3)} m, not 3.7 m`);
});

it('an in-range storey is unchanged, and a floor outside the range keeps the clamped fallback', () => {
  act(() => activate!({ ...top, elevation: 0 }));
  assert.ok(Math.abs(s().sectionPlane.position - 40) < 1e-9, 'floor 0 + 1.2 m is 40 % of [0, 3]');
  act(() => activate!({ ...top, elevation: 10 }));
  assert.equal(s().sectionPlane.position, 100, 'a floor above the range clamps');
  act(() => activate!({ ...top, elevation: -4 }));
  assert.equal(s().sectionPlane.position, 0, 'a floor below the range clamps');
});

it('a federated bounds change keeps the percentage, and re-activating recomputes floor + 1.2 m', () => {
  act(() => activate!(top));
  const stored = s().sectionPlane.position;
  // A second model raises the merged top to 6 m: like every percentage cut,
  // the stored position is unchanged (fixing world anchoring across bounds
  // changes is out of scope for #8162), so it now resolves elsewhere.
  load(bounded('a', 3), bounded('b', 6));
  assert.equal(s().sectionPlane.position, stored, 'a bounds change does not rewrite the stored position');
  act(() => activate!(top));
  assert.ok(Math.abs(cutY(6) - 3.7) < 1e-9, `re-activating cuts at 3.7 m of the new [0, 6] range, got ${cutY(6)}`);
  assert.ok(s().sectionPlane.position < 100, 'now inside the range');
  // And back: hiding the taller model brings the top back to 3 m; re-activating extrapolates again.
  load(bounded('a', 3), { ...bounded('b', 6), visible: false });
  act(() => activate!(top));
  assert.ok(Math.abs(cutY(3) - 3.7) < 1e-9, `got ${cutY(3)}`);
});
