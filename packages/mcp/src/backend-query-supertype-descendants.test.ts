/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.query().byType(...)` (backend-query.ts) used to expand a caller's type
 * through a fixed nine-entry `IFC_SUBTYPES` table — only `*StandardCase`/
 * `*ElementedCase` aliases. Asking for an abstract EXPRESS supertype
 * (`IfcBuildingElement`, `IfcElement`) is never a literal STEP entity type,
 * so that table had no row for it and `byType('IfcBuildingElement')` silently
 * answered zero on a model full of matching elements. `expandTypes` now
 * delegates to `@ifc-lite/data`'s schema-driven descendant resolver. This
 * proves the fix against a real fixture through the MCP backend.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadIfcModel } from './loader.js';
import type { LoadedModel } from './context.js';

/** A 22-character IFC GlobalId from a short mnemonic. */
function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

function ifcFile(dataSection: string, schema: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
${dataSection}
ENDSEC;
END-ISO-10303-21;
`;
}

const IFC4_MODEL = ifcFile(`#70= IFCWALL('${guid('WAL1')}',$,'Wall 1',$,$,$,$,'tag',$);
#71= IFCWALLSTANDARDCASE('${guid('WAL2')}',$,'Wall 2',$,$,$,$,'tag',$);
#72= IFCSLAB('${guid('SLAB')}',$,'Slab',$,$,$,$,'tag',$);
#73= IFCCOLUMN('${guid('COLM')}',$,'Column',$,$,$,$,'tag',$);`, 'IFC4');

let ifc4Tmp: string;
let ifc4Model: LoadedModel;

beforeAll(async () => {
  ifc4Tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-supertype-'));
  await writeFile(join(ifc4Tmp, 'm.ifc'), IFC4_MODEL, 'utf-8');
  ifc4Model = await loadIfcModel(join(ifc4Tmp, 'm.ifc'), { modelId: 'm' });
});

afterAll(async () => {
  await rm(ifc4Tmp, { recursive: true, force: true });
});

describe('byType resolves an abstract EXPRESS supertype to its concrete leaves (IFC4)', () => {
  it('byType("IfcBuildingElement") finds all 4 building elements, not 0', () => {
    expect(ifc4Model.bim.query().byType('IfcBuildingElement').toArray()).toHaveLength(4);
  });

  it('byType("IfcWall") still returns 2 — no regression on the StandardCase alias', () => {
    expect(ifc4Model.bim.query().byType('IfcWall').toArray()).toHaveLength(2);
  });

  it('byType("IfcFooting") — a real IFC type with no instances in this fixture — returns 0', () => {
    expect(ifc4Model.bim.query().byType('IfcFooting').toArray()).toHaveLength(0);
  });
});

describe('byType resolves per the model\'s own schema version (IFC4X3)', () => {
  it('byType("IfcBuiltElement") resolves on an IFC4X3 model (renamed from IfcBuildingElement)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-supertype-4x3-'));
    try {
      const source = ifcFile(`#70= IFCWALL('${guid('WAL1')}',$,'Wall',$,$,$,$,'tag',$);
#71= IFCCOURSE('${guid('CRSE')}',$,'Course',$,$,$,$,'tag',$);`, 'IFC4X3');
      await writeFile(join(dir, 'm.ifc'), source, 'utf-8');
      const model = await loadIfcModel(join(dir, 'm.ifc'), { modelId: 'm' });
      expect(model.bim.query().byType('IfcBuiltElement').toArray()).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
