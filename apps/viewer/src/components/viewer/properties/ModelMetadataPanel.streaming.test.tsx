/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6411: the model statistics walk every mesh to count "Elements with
 * Geometry". While geometry streams, each publish hands the panel a model
 * with more meshes, twice a second on a large load, so the count follows the
 * streaming refresh cadence instead and is exact once streaming ends.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { act, useState } from 'react';
import { settleLoadWindow } from '@/test/load-window';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { ModelMetadataPanel } from './ModelMetadataPanel';

afterEach(() => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState({ geometryStreamingActive: false, loading: false });
});

const STEP = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000aa',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building000000000000a',$,'B',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('0Storey00000000000000a',$,'00',$,$,$,$,$,.ELEMENT.,0.);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$);
#6=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',());
#7=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));
#10=IFCWALL('0Wall10000000000000000',$,'W1',$,$,$,#7,$,$);
#11=IFCWALL('0Wall11000000000000000',$,'W2',$,$,$,#7,$,$);
#12=IFCWALL('0Wall12000000000000000',$,'W3',$,$,$,#7,$,$);
#20=IFCRELAGGREGATES('0Agg200000000000000000',$,$,$,#1,(#2));
#21=IFCRELAGGREGATES('0Agg210000000000000000',$,$,$,#2,(#3));
#22=IFCRELAGGREGATES('0Agg220000000000000000',$,$,$,#3,(#4));
#30=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont30000000000000000',$,$,$,(#10,#11,#12),#4);
ENDSEC;
END-ISO-10303-21;`;

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

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(STEP);
  return new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
}

/** The number rendered after the "Elements with Geometry" label. */
function elementsWithGeometry(panel: HTMLElement): string {
  const match = /Elements with Geometry[^\d—]*([\d,]+|—)/.exec(panel.textContent ?? '');
  return match ? match[1] : `<not found in ${JSON.stringify(panel.textContent)}>`;
}

/** The value rendered after the "Building Storeys" label. */
function buildingStoreys(panel: HTMLElement): string {
  const match = /Building Storeys[^\d—]*([\d,]+|—)/.exec(panel.textContent ?? '');
  return match ? match[1] : `<not found in ${JSON.stringify(panel.textContent)}>`;
}

it('shows a dash while the load window is open and the exact counts once it settles (load window; supersedes #6411)', async () => {
  const dataStore = await parse();
  const model = (ids: number[]) => ({
    id: 'legacy', name: 'M', ifcDataStore: dataStore, geometryResult: geometry(ids),
    loadState: 'streaming-geometry', fileSize: 1, loadedAt: 0,
  }) as FederatedModel;
  useViewerStore.setState({ geometryStreamingActive: true, mutationViews: new Map(), mutationVersion: 0 });

  let setModel: (m: FederatedModel) => void = () => {};
  function Host() {
    const [current, set] = useState(model([10]));
    setModel = set;
    return <ModelMetadataPanel model={current} />;
  }
  const panel = render(<Host />);
  assert.equal(elementsWithGeometry(panel), '—', 'early read: placeholder, never a provisional count');
  assert.equal(buildingStoreys(panel), '—');

  act(() => setModel(model([10, 11, 12])));
  assert.equal(elementsWithGeometry(panel), '—', 'a publish inside the window computes nothing');

  act(() => useViewerStore.setState({ geometryStreamingActive: false }));
  await settleLoadWindow();
  assert.equal(elementsWithGeometry(panel), '3', 'settled: the exact count');
  assert.equal(buildingStoreys(panel), '1');
});

it('waits for the whole load window, whichever model streams, and then shows the displayed model\'s own count', async () => {
  const dataStore = await parse();
  const model = (id: string, ids: number[], loadState: FederatedModel['loadState']) => ({
    id, name: id, ifcDataStore: dataStore, geometryResult: geometry(ids), loadState, fileSize: 1, loadedAt: 0,
  }) as FederatedModel;
  // The global flag stays on: another federated model is still streaming. The
  // main thread is shared, so a finished model's statistics wait for it too.
  useViewerStore.setState({ geometryStreamingActive: true, mutationViews: new Map(), mutationVersion: 0 });

  let setModel: (m: FederatedModel) => void = () => {};
  function Host() {
    const [current, set] = useState(model('legacy', [10, 11], 'complete'));
    setModel = set;
    return <ModelMetadataPanel model={current} />;
  }
  const panel = render(<Host />);
  assert.equal(elementsWithGeometry(panel), '—');

  act(() => setModel(model('default', [10, 11, 12], 'streaming-geometry')));
  assert.equal(elementsWithGeometry(panel), '—', 'never the previous model\'s value');

  act(() => useViewerStore.setState({ geometryStreamingActive: false }));
  await settleLoadWindow();
  assert.equal(elementsWithGeometry(panel), '3', 'settled: the displayed model\'s count');
});
