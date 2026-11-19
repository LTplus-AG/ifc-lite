/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { StoreApi } from 'zustand';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { geometryBackingCommand } from '@/lib/geometry-backing/backing-debug-hook';
import type { TapState } from '@/lib/geometry-backing/store-backing-tap';
import { PropertiesPanel } from './PropertiesPanel';

it('#10887 a legacy selection keeps its displayed centre after CPU geometry release', async () => {
  const initial = useViewerStore.getState();
  const bytes = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#42=IFCWALL('0Wall00000000000000042',$,'Wall A',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`);
  const parsed = await new IfcParser().parseColumnar(bytes.buffer);
  const mesh: MeshData = { expressId: 42, ifcType: 'IfcWall',
    positions: Float32Array.from([2, 4, 6, 8, 4, 6, 2, 10, 12]),
    normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
  const geometry: GeometryResult = { meshes: [mesh], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 2, y: 4, z: 6 }, max: { x: 8, y: 10, z: 12 } },
      shiftedBounds: { min: { x: 2, y: 4, z: 6 }, max: { x: 8, y: 10, z: 12 } } } };
  useViewerStore.setState({ models: new Map([['__legacy__', {
    ...fixtureModel('__legacy__'), ifcDataStore: parsed, geometryResult: geometry, maxExpressId: 42,
  }]]), ifcDataStore: parsed, geometryResult: geometry, activeModelId: null,
  selectedEntity: { modelId: 'legacy', expressId: 42 }, selectedEntityId: 42,
  selectedEntityIds: new Set([42]), selectedEntities: [], selectedEntitiesSet: new Set() });
  const store = useViewerStore as unknown as StoreApi<TapState>;
  const position = (ui: HTMLElement): string => {
    const row = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Position'));
    assert.ok(row, 'selected wall has a Position row');
    assert.match(row.textContent ?? '', /5\.000/, 'the resident centre is visible');
    return row.textContent ?? '';
  };
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: {
      database: { name: `legacy-centre-${process.pid}`, locks: null },
    } as never });
    const rows = await geometryBackingCommand(store, undefined, { action: 'seal' });
    assert.ok(rows.every((row) => row.complete));
    const before = position(render(<PropertiesPanel />));
    cleanup();
    releaseCpuMeshBuffers(geometry.meshes);
    assert.equal(position(render(<PropertiesPanel />)), before, 'same coordinates from backed bounds under __legacy__');
  } finally {
    cleanup();
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    useViewerStore.setState(initial, true);
  }
});
