/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The physical-to-analytical counterpart lookup, both directions (#9668).
 * Expected ids are copied from each fixture's IfcRelAssignsToProduct records,
 * not derived from the read model under test.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from './index.js';
import { extractStructuralOnDemand } from './structural-extractor.js';
import { structuralCounterparts } from './structural-counterparts.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function parse(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new IfcParser().parseColumnar(buffer);
}

const FIXTURES = [
  {
    path: 'ara3d/ISSUE_171_IfcSurfaceCurveSweptAreaSolid.ifc',
    schema: 'IFC4',
    // #2676..#2783: the footing sits in RelatedObjects, each member in RelatingProduct.
    physical: 2671,
    analytical: [2675, 2706, 2725, 2744, 2763, 2782],
  },
  {
    path: 'structural/ifc_structuralanalysisview/roof_truss--Axis-Struc.ifc',
    schema: 'IFC2X3',
    // #618: three members in RelatedObjects, the column in RelatingProduct.
    physical: 112,
    analytical: [266, 288, 310],
  },
];

describe('structuralCounterparts on real files', () => {
  it('lists the fixtures in the committed manifest so CI fetches them', () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'tests/models/manifest.json'), 'utf8')) as { files?: { path?: string }[] };
    const paths = (manifest.files ?? []).map((file) => file.path);
    for (const fixture of FIXTURES) expect(paths).toContain(fixture.path);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.schema}: ${fixture.path.split('/').pop()} links #${fixture.physical} both ways`, async (ctx) => {
      const file = resolve(REPO_ROOT, 'tests/models', fixture.path);
      if (!existsSync(file)) ctx.skip(`${fixture.path} missing — run \`pnpm fixtures\` to fetch it`);
      const store = await parse(readFileSync(file));
      expect(store.schemaVersion).toBe(fixture.schema);
      const data = extractStructuralOnDemand(store);

      expect(structuralCounterparts(data, fixture.physical)).toEqual({ side: 'analytical', expressIds: fixture.analytical });
      for (const item of fixture.analytical) {
        expect(structuralCounterparts(data, item)).toEqual({ side: 'physical', expressIds: [fixture.physical] });
      }
      const unlinked = data.connections.find((connection) => !connection.physicalElementIds?.length);
      expect(unlinked).toBeDefined();
      expect(structuralCounterparts(data, unlinked!.expressId)).toBeNull();
    });
  }
});

const IFC4X3 = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4X3_ADD2'));ENDSEC;DATA;
#9=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
#1=IFCWALL('2Wall000000000000000001',$,'Wall A',$,$,$,$,$,$);
#2=IFCSLAB('2Slab000000000000000001',$,'Slab',$,$,$,$,$,$);
#3=IFCSTRUCTURALSURFACEMEMBER('2Memb000000000000000001',$,'Shell',$,$,$,$,.SHELL.,0.2);
#4=IFCSTRUCTURALCURVECONNECTION('2Conn000000000000000001',$,'Edge',$,$,$,$,$,$);
#5=IFCRELASSIGNSTOPRODUCT('2Rel0000000000000000001',$,$,$,(#3,#4),$,#1);
#6=IFCRELASSIGNSTOPRODUCT('2Rel0000000000000000002',$,$,$,(#3),$,#2);
ENDSEC;END-ISO-10303-21;`;

describe('structuralCounterparts on an IFC4X3 file', () => {
  it('lists a member and a connection on one wall, and two elements on one member', async () => {
    const data = extractStructuralOnDemand(await parse(new TextEncoder().encode(IFC4X3)));
    expect(structuralCounterparts(data, 1)).toEqual({ side: 'analytical', expressIds: [3, 4] });
    expect(structuralCounterparts(data, 2)).toEqual({ side: 'analytical', expressIds: [3] });
    expect(structuralCounterparts(data, 3)).toEqual({ side: 'physical', expressIds: [1, 2] });
    expect(structuralCounterparts(data, 4)).toEqual({ side: 'physical', expressIds: [1] });
    expect(structuralCounterparts(data, 5)).toBeNull();
  });
});
