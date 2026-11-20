/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { zonePropertySetName, type ZoneSet } from '@/lib/zones';
import { model, parseStep, seed, viewerHost } from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';

const WALL_ID = 42;
const STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('zones','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#5),$);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#${WALL_ID}=IFCWALL('0Wall00000000000000042',$,'Wall A',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;
const ZONE_SET: ZoneSet = { id: 'set-1', name: 'Takt areas', zones: [{ id: 'z-a', name: 'Takt A', center: [0, 0, 0], size: [10, 10, 10], rotationY: 0 }],
  visible: true, createdAt: 0, updatedAt: 0 };
const mesh = (): MeshData => ({ expressId: WALL_ID, positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] });
const geometry = (meshes: MeshData[]): GeometryResult => ({ meshes, totalTriangles: 1, totalVertices: 3,
  coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, hasLargeCoordinates: false } });

const initial = useViewerStore.getState();
let host: ReturnType<typeof viewerHost>;
beforeEach(async () => {
  resetFeaturesForTest();
  const result = geometry([mesh()]);
  seed([model('m1', await parseStep(new TextEncoder().encode(STEP)), { geometryResult: result })]);
  useViewerStore.setState({ geometryResult: result, zoneSets: [ZONE_SET], zoneApportionment: new Map(),
    zoneAssignments: new Map([[WALL_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: false, touchedZoneIds: ['z-a'] } }]]) as never });
  host = viewerHost();
});
afterEach(() => { useViewerStore.setState(initial); resetFeaturesForTest(); });
const execute = (operation_id: string, input: Record<string, unknown>) =>
  dispatchMainViewerTool(host, 'viewer_operation_execute', { model_id: 'm1', operation_id, input }, { canEdit: () => true });
async function prepare(): Promise<string> {
  const prepared = await execute('zones.writeback.prepare', { set_id: 'set-1', model_ids: ['m1'], basis: 'mesh', action: 'write' });
  assert.equal(prepared.isError, false, prepared.text);
  return (JSON.parse((prepared.structured as { result: { native_json: string } }).result.native_json) as { token: string }).token;
}

test('a recolour between prepare and apply does not void the reviewed zone writeback (#10669)', async () => {
  const token = await prepare();
  const before = useViewerStore.getState();
  before.updateMeshColors(new Map([[WALL_ID, [1, 0, 0, 1]]]), { override: true });
  assert.notEqual(useViewerStore.getState().models, before.models, 'the recolour replaced the models Map');
  const applied = await execute('zones.writeback.apply', { token });
  assert.equal(applied.isError, false, applied.text);
  const pset = useViewerStore.getState().getMutationView('m1')?.getForEntity(WALL_ID).find(set => set.name === zonePropertySetName(ZONE_SET.name));
  assert.deepEqual(pset?.properties.find(property => property.name === 'Zone')?.value, 'Takt A', 'the reviewed zone landed on the wall');
});

test('a geometry change between prepare and apply still refuses the zone writeback', async () => {
  const token = await prepare();
  const moved = { ...mesh(), positions: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
  useViewerStore.getState().setGeometryResult(geometry([moved]));
  const applied = await execute('zones.writeback.apply', { token });
  assert.equal(applied.isError, true);
  assert.match(applied.text, /changed after review/);
});

test('an in-place geometry change between prepare and apply still refuses the zone writeback', async () => {
  const token = await prepare();
  useViewerStore.getState().bumpGeometryContentVersion();
  const applied = await execute('zones.writeback.apply', { token });
  assert.equal(applied.isError, true);
  assert.match(applied.text, /changed after review/);
});
