/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A server-hydrated store must key `entityIndex.byType` the way the client
 * parser does: by the UPPERCASE STEP class name. Keying by `IfcTypeEnum`
 * filed every class outside the enum (all IfcStructural*, IfcPump, ...) under
 * one 'Unknown' bucket and spelled the rest PascalCase, so readers asking for
 * 'IFCSTRUCTURALCURVEMEMBER' or 'IFCWALL' found nothing on server models
 * (Part of #9668).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { ServerEntityIndex, type DataModel } from '@ifc-lite/server-client';
import { convertServerDataModel, type ServerParseResult } from './serverDataModel';

const ROWS = [
  { id: 1, raw: 'IFCPROJECT' },
  { id: 100, raw: 'IFCWALL' },
  { id: 200, raw: 'IFCSTRUCTURALANALYSISMODEL' },
  { id: 201, raw: 'IFCSTRUCTURALCURVEMEMBER' },
  { id: 202, raw: 'IFCSTRUCTURALCURVEMEMBER' },
  { id: 204, raw: 'IfcStructuralCurveMember' },
  { id: 203, raw: 'IFCSTRUCTURALPOINTCONNECTION' },
];

const STEP = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#100=IFCWALL('Wall00000000000000001A',$,'W',$,$,$,$,$,$);
#200=IFCSTRUCTURALANALYSISMODEL('Sam000000000000000001A',$,'M',$,$,.LOADING_3D.,$,$,$,$);
#201=IFCSTRUCTURALCURVEMEMBER('Scm000000000000000001A',$,'C1',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#202=IFCSTRUCTURALCURVEMEMBER('Scm000000000000000002A',$,'C2',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#204=IfcStructuralCurveMember('Scm000000000000000004A',$,'C4',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#203=IFCSTRUCTURALPOINTCONNECTION('Spc000000000000000001A',$,'N',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

const parseResult: ServerParseResult = {
  cache_key: 'by-type',
  metadata: { schema_version: 'IFC4' },
  stats: { total_time_ms: 1, parse_time_ms: 1, geometry_time_ms: 0, total_vertices: 0, total_triangles: 0 },
};

function serverStore(rows: { id: number; raw: string }[] = ROWS) {
  const dataModel = {
    entities: ServerEntityIndex.fromRows(rows.map((r, i) => ({
      entity_id: r.id,
      type_name: r.raw,
      global_id: `G${i}`.padEnd(22, 'x'),
      name: `E${r.id}`,
      has_geometry: false,
    }))),
    propertySets: new Map(),
    quantitySets: new Map(),
    relationships: [],
    classifications: [],
    materials: [],
    documents: [],
    spatialHierarchy: {
      nodes: [{ entity_id: 1, parent_id: 0, level: 0, path: 'P', type_name: 'IFCPROJECT', name: 'P', children_ids: [], element_ids: [] }],
      project_id: 1,
      element_to_storey: new Map(),
      element_to_building: new Map(),
      element_to_site: new Map(),
      element_to_space: new Map(),
    },
  } as unknown as DataModel;
  return convertServerDataModel(dataModel, parseResult, { size: 1 }, []);
}

const sorted = (m: ReadonlyMap<string, readonly number[]>) =>
  [...m].map(([k, ids]) => [k, [...ids].sort((a, b) => a - b)] as const).sort(([a], [b]) => a.localeCompare(b));

describe('server-hydrated entityIndex.byType', () => {
  it('keys every class by its UPPERCASE STEP name, with no Unknown bucket', () => {
    const { byType } = serverStore().entityIndex;
    assert.equal(byType.has('Unknown'), false, 'classes outside IfcTypeEnum collapsed into Unknown');
    assert.deepEqual(byType.get('IFCSTRUCTURALCURVEMEMBER'), [201, 202, 204]);
    assert.deepEqual(byType.get('IFCSTRUCTURALPOINTCONNECTION'), [203]);
    assert.deepEqual(byType.get('IFCWALL'), [100]);
  });

  it('files a row with no class under no key, as the client parser has none', () => {
    const { byType } = serverStore([...ROWS, { id: 300, raw: '' }]).entityIndex;
    assert.equal([...byType.values()].some(ids => ids.includes(300)), false);
  });

  it('has the same keys and members as the client parser on the same model', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const client = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
    const wanted = new Set(ROWS.map(r => r.raw.toUpperCase()));
    const clientSubset = new Map([...client.entityIndex.byType].filter(([k]) => wanted.has(k)));
    assert.equal(clientSubset.size, wanted.size, 'client parse did not index every fixture class');
    assert.deepEqual(sorted(serverStore().entityIndex.byType), sorted(clientSubset));
  });
});
