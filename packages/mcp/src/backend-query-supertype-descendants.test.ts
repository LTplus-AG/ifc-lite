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

/** The `type` of every entity a query answered with, sorted, for exact-set
 * comparison. A count alone passes on the right number of the wrong entities,
 * which is the failure an expansion bug actually produces. */
function typesOf(model: LoadedModel, type: string): string[] {
  return model.bim
    .query()
    .byType(type)
    .toArray()
    .map((e) => e.type)
    .sort();
}

describe('byType resolves an abstract EXPRESS supertype to its concrete leaves (IFC4)', () => {
  it('byType("IfcBuildingElement") finds all 4 building elements, not 0', () => {
    expect(typesOf(ifc4Model, 'IfcBuildingElement')).toEqual([
      'IfcColumn',
      'IfcSlab',
      'IfcWall',
      'IfcWallStandardCase',
    ]);
  });

  it('byType("IfcWall") still returns 2 — no regression on the StandardCase alias', () => {
    expect(typesOf(ifc4Model, 'IfcWall')).toEqual(['IfcWall', 'IfcWallStandardCase']);
  });

  it('byType("IfcFooting") — a real IFC type with no instances in this fixture — returns 0', () => {
    expect(typesOf(ifc4Model, 'IfcFooting')).toEqual([]);
  });
});

describe('byType resolves an IFC4X3-only supertype (IfcBuildingElement renamed)', () => {
  it('byType("IfcBuiltElement") resolves on an IFC4X3 model (renamed from IfcBuildingElement)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-supertype-4x3-'));
    try {
      const source = ifcFile(`#70= IFCWALL('${guid('WAL1')}',$,'Wall',$,$,$,$,'tag',$);
#71= IFCCOURSE('${guid('CRSE')}',$,'Course',$,$,$,$,'tag',$);`, 'IFC4X3');
      await writeFile(join(dir, 'm.ifc'), source, 'utf-8');
      const model = await loadIfcModel(join(dir, 'm.ifc'), { modelId: 'm' });
      expect(typesOf(model, 'IfcBuiltElement')).toEqual(['IfcCourse', 'IfcWall']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Expanding an abstract type must not walk out of the product branch.
 *
 * `IfcRoot` is the ancestor of everything with a GlobalId, so expanding it
 * whole turned `byType('IfcRoot')` into "every rooted record in the file" —
 * property sets, `IfcRel*`, `*Type`. `count_entities({type:'IfcObject',
 * group_by:'storey'})` then calls `storey()` on relationships. The untyped
 * branch of this backend has always answered with `isProductType` only; the
 * typed branch has to agree with it. The requested type itself is never
 * gated, so asking for a property set by name still works.
 */
describe('an abstract-root expansion stays inside the product branch', () => {
  let dir: string;
  let model: LoadedModel;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-branch-'));
    const source = ifcFile(`#70= IFCWALL('${guid('WAL1')}',$,'Wall',$,$,$,$,'tag',$);
#71= IFCWALLTYPE('${guid('WALT')}',$,'Wall type',$,$,$,$,$,$,.STANDARD.);
#72= IFCPROPERTYSET('${guid('PSET')}',$,'Pset_Test',$,(#73));
#73= IFCPROPERTYSINGLEVALUE('P',$,IFCLABEL('v'),$);
#74= IFCRELDEFINESBYPROPERTIES('${guid('RDBP')}',$,$,$,(#70),#72);`, 'IFC4');
    await writeFile(join(dir, 'm.ifc'), source, 'utf-8');
    model = await loadIfcModel(join(dir, 'm.ifc'), { modelId: 'm' });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // The fixture holds exactly one of each of IfcWall, IfcWallType,
  // IfcPropertySet, IfcPropertySingleValue and IfcRelDefinesByProperties, plus
  // the header's IfcProject, so an exact set says both what the gate keeps and
  // what it drops. A membership check said only the second.
  it('byType("IfcRoot") answers with products only, not property sets or relationships', () => {
    expect(typesOf(model, 'IfcRoot')).toEqual(['IfcProject', 'IfcWall']);
  });

  it('byType("IfcObjectDefinition") does not sweep in type objects', () => {
    expect(typesOf(model, 'IfcObjectDefinition')).toEqual(['IfcProject', 'IfcWall']);
  });

  it('byType("IfcPropertySet") still finds the property set — the gate never drops the requested type', () => {
    expect(typesOf(model, 'IfcPropertySet')).toEqual(['IfcPropertySet']);
  });

  it('byType("IfcBuildingElementType") keeps its own subtypes — the gate is a branch, not a ban', () => {
    expect(typesOf(model, 'IfcBuildingElementType')).toEqual(['IfcWallType']);
  });
});
