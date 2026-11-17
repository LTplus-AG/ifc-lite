/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10119: the visible-only GLB export gates class toggles by the class after a
 *  retype, as the viewport does, not by the class the mesh was built with. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryProcessor, type MeshData, type GeometryResult } from '@ifc-lite/geometry';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { render, cleanup, click, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { GLBExportDialog } from './GLBExportDialog';

afterEach(() => { cleanup(); mock.restoreAll(); });
beforeEach(() => { useViewerStore.getState().resetViewerState(); });

const zero = { x: 0, y: 0, z: 0 };
const mesh = (expressId: number, ifcType: string): MeshData => ({ expressId, ifcType,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1], origin: [0, 0, 0] });

it('#10119 visible-only GLB hides a mesh retyped to IfcSpace and keeps one retyped away from it', async () => {
  const store = createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0, entities: [
    { expressId: 1, type: 'IfcSpace', hasGeometry: true },
    { expressId: 2, type: 'IfcWall', hasGeometry: true },
  ] });
  const geometry: GeometryResult = { meshes: [mesh(1, 'IfcSpace'), mesh(2, 'IfcWall')], totalTriangles: 2, totalVertices: 6,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false } };
  const view = new MutablePropertyView(null, 'm');
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }), ifcDataStore: store, maxExpressId: 2, geometryResult: geometry }),
    mutationViews: new Map([['m', view]]),
    typeVisibility: { ...useViewerStore.getState().typeVisibility, spaces: false },
  });
  const editor = new StoreEditor(store, view);
  editor.setEntityType(1, 'IfcWall');
  editor.setEntityType(2, 'IfcSpace');
  let exported: MeshData[] | undefined;
  mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  mock.method(GeometryProcessor.prototype, 'exportGlbFromMeshes', (meshes: MeshData[]) => { exported = meshes; return new Uint8Array([1]); });
  const button = (label: string) => {
    const el = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    assert.ok(el, `no button labelled "${label}"`);
    return el;
  };
  render(<GLBExportDialog surface="ribbon" />);
  click(button('Export GLB'));
  await advance(1);
  click(document.querySelector('button[role="switch"]')!);
  await advance(1);
  click(button('Export'));
  await advance(20);
  assert.deepEqual(exported?.map((m) => m.expressId), [1]);
});
