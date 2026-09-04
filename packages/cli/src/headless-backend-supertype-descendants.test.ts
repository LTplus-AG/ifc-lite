/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.query().byType(...)`'s type expansion used to walk a fixed nine-entry
 * `IFC_SUBTYPES` table (only `*StandardCase`/`*ElementedCase` aliases). Asking
 * for an abstract EXPRESS supertype — `IfcBuildingElement`, `IfcElement` — is
 * never a literal STEP entity type, so that table had no row for it and
 * `byType('IfcBuildingElement')` silently answered zero on a model full of
 * matching elements. `expandTypes` now delegates to `@ifc-lite/data`'s
 * schema-driven descendant resolver instead. This proves the fix against a
 * real fixture parsed by the real columnar parser.
 */

import { describe, expect, it } from 'vitest';
import { ifcFile, loadInlineModel } from './headless-test-helpers.js';

const IFC4_MODEL = ifcFile(`#70= IFCWALL('WALL00000000000000000X',$,'Wall 1',$,$,$,$,'tag',$);
#71= IFCWALLSTANDARDCASE('WALS00000000000000000X',$,'Wall 2',$,$,$,$,'tag',$);
#72= IFCSLAB('SLAB00000000000000000X',$,'Slab',$,$,$,$,'tag',$);
#73= IFCCOLUMN('COLM00000000000000000X',$,'Column',$,$,$,$,'tag',$);
#74= IFCFURNISHINGELEMENT('FURN00000000000000000X',$,'Control furnishing',$,$,$,$,'tag');`, 'IFC4');

const loadIfc4Model = () => loadInlineModel(IFC4_MODEL, 'supertype-ifc4');

describe('byType resolves an abstract EXPRESS supertype to its concrete leaves (IFC4)', () => {
  it('byType("IfcBuildingElement") finds all 4 building elements, not 0', async () => {
    const bim = await loadIfc4Model();
    const result = bim.query().byType('IfcBuildingElement').toArray();
    expect(result.length).toBe(4);
  });

  it('byType("IfcElement") finds all 5 (a higher abstract ancestor, also covers the furnishing control)', async () => {
    // IfcElement is a broader ancestor than IfcBuildingElement — it also
    // covers IfcFurnishingElement, so the count is one higher here.
    const bim = await loadIfc4Model();
    const result = bim.query().byType('IfcElement').toArray();
    expect(result.length).toBe(5);
  });

  it('byType("IfcWall") still returns 2 — no regression on the StandardCase alias', async () => {
    const bim = await loadIfc4Model();
    const result = bim.query().byType('IfcWall').toArray();
    expect(result.length).toBe(2);
  });

  it('byType("IfcSpace") — a real IFC type with no instances in this fixture — returns 0', async () => {
    const bim = await loadIfc4Model();
    const result = bim.query().byType('IfcSpace').toArray();
    expect(result.length).toBe(0);
  });
});

const IFC4X3_MODEL = ifcFile(`#70= IFCWALL('WALL00000000000000000X',$,'Wall',$,$,$,$,'tag',$);
#71= IFCCOURSE('CRSE00000000000000000X',$,'Course',$,$,$,$,'tag',$);`, 'IFC4X3');

describe('byType resolves an IFC4X3-only supertype (IfcBuildingElement renamed)', () => {
  it('byType("IfcBuiltElement") resolves on an IFC4X3 model (renamed from IfcBuildingElement)', async () => {
    const bim = await loadInlineModel(IFC4X3_MODEL, 'supertype-ifc4x3');
    const result = bim.query().byType('IfcBuiltElement').toArray();
    expect(result.length).toBe(2);
  });
});

/**
 * The descendant closure must not be narrowed by the file's schema header.
 *
 * `entityIndex.byType` is keyed by the names the FILE contains, not by what the
 * header claims the schema is, and re-headering happens: converters, authoring
 * tools and hand-edits all produce IFC4X3-headered files still carrying
 * `IFCSLABSTANDARDCASE`, and IFC2X3-headered files carrying `IFCFURNITURE`. A
 * per-schema-version closure answered zero for exactly those records while the
 * same bytes under an IFC4 header answered three, so the header — not the
 * content — decided what a query found.
 *
 * The three fixtures below are byte-identical apart from `FILE_SCHEMA`, so any
 * difference in what `byType` returns is the header alone.
 */
const CROSS_HEADER_DATA = `#70= IFCSLAB('SLB000000000000000000X',$,'Slab',$,$,$,$,'tag',$);
#71= IFCSLABSTANDARDCASE('SLBS00000000000000000X',$,'Slab standard case',$,$,$,$,'tag',$);
#72= IFCSLABELEMENTEDCASE('SLBE00000000000000000X',$,'Slab elemented case',$,$,$,$,'tag',$);
#73= IFCFURNITURE('FURN00000000000000000X',$,'Furniture',$,$,$,$,'tag',$);
#74= IFCSYSTEMFURNITUREELEMENT('SFUR00000000000000000X',$,'System furniture',$,$,$,$,'tag',$);
#75= IFCSOLIDSTRATUM('SSTR00000000000000000X',$,'Solid stratum',$,$,$,$,'tag',$);
#76= IFCWATERSTRATUM('WSTR00000000000000000X',$,'Water stratum',$,$,$,$,'tag',$);
#77= IFCWALL('WALL00000000000000000X',$,'Wall',$,$,$,$,'tag',$);
#78= IFCCOURSE('CRSE00000000000000000X',$,'Course',$,$,$,$,'tag',$);`;

const CROSS_HEADER_SCHEMAS = ['IFC2X3', 'IFC4', 'IFC4X3'] as const;

async function idsByType(schema: string, type: string): Promise<number[]> {
  const bim = await loadInlineModel(ifcFile(CROSS_HEADER_DATA, schema), `cross-header-${schema}`);
  return bim.query().byType(type).toArray().map((e) => e.ref.expressId).sort((a, b) => a - b);
}

/**
 * The counterweight to the block above: a name the file's OWN schema declares
 * is never pulled in from a version the file is not written in.
 *
 * buildingSMART re-parented entities between versions, so widening to a plain
 * union misfiled 45 (supertype, schema) pairs. Each fixture here holds the
 * re-parented record and asks for a base it is NOT under on that header.
 */
describe('a re-parented entity is not swept in from another schema', () => {
  it('IfcBuildingElement on an IFC4 file does not return an IfcReinforcingBar', async () => {
    // IfcReinforcingBar is an IfcBuildingElement in IFC2X3 and an
    // IfcElementComponent from IFC4 on.
    const source = ifcFile(`#70= IFCWALL('WALL00000000000000000X',$,'Wall',$,$,$,$,'tag',$);
#71= IFCREINFORCINGBAR('RBAR00000000000000000X',$,'Rebar',$,$,$,$,'tag',$,$,$,$,$);`, 'IFC4');
    const bim = await loadInlineModel(source, 'reparent-ifc4');
    const types = bim.query().byType('IfcBuildingElement').toArray().map((e) => e.type);
    expect(types).toEqual(['IfcWall']);
    // Anti-vacuity: the record is in the file and reachable under the class it
    // really has on this schema.
    expect(bim.query().byType('IfcElementComponent').toArray().map((e) => e.type)).toEqual([
      'IfcReinforcingBar',
    ]);
  });

  it('IfcBuildingElement on an IFC2X3 file DOES return it — the parentage that schema declares', async () => {
    const source = ifcFile(`#70= IFCWALL('WALL00000000000000000X',$,'Wall',$,$,$,$,'tag',$);
#71= IFCREINFORCINGBAR('RBAR00000000000000000X',$,'Rebar',$,$,$,$,'tag',$,$,$,$,$);`, 'IFC2X3');
    const bim = await loadInlineModel(source, 'reparent-ifc2x3');
    const types = bim.query().byType('IfcBuildingElement').toArray().map((e) => e.type).sort();
    expect(types).toEqual(['IfcReinforcingBar', 'IfcWall']);
  });

  it.each(['IFC4', 'IFC4X3'])('IfcObject on a %s file does not return the IfcProject', async (schema) => {
    // IfcProject is an IfcObject in IFC2X3 and an IfcContext from IFC4 on.
    const bim = await loadInlineModel(ifcFile(`#70= IFCWALL('WALL00000000000000000X',$,'Wall',$,$,$,$,'tag',$);`, schema), `reparent-obj-${schema}`);
    expect(bim.query().byType('IfcObject').toArray().map((e) => e.type)).not.toContain('IfcProject');
  });

  it('IfcSystem on an IFC2X3 file does not return an IfcZone', async () => {
    // IfcZone is an IfcGroup in IFC2X3 and an IfcSystem in IFC4.
    const source = ifcFile(`#70= IFCZONE('ZONE00000000000000000X',$,'Zone',$,$);`, 'IFC2X3');
    const bim = await loadInlineModel(source, 'reparent-zone-2x3');
    expect(bim.query().byType('IfcSystem').toArray()).toHaveLength(0);
    expect(bim.query().byType('IfcGroup').toArray().map((e) => e.type)).toEqual(['IfcZone']);
  });
});

describe('a re-headered file answers byType the same under every schema header', () => {
  it.each([
    ['IfcSlab', [70, 71, 72]],
    ['IfcFurnishingElement', [73, 74]],
    ['IfcGeotechnicalStratum', [75, 76]],
  ])('%s returns the same rows under IFC2X3, IFC4 and IFC4X3', async (type, expected) => {
    for (const schema of CROSS_HEADER_SCHEMAS) {
      expect(await idsByType(schema, type), `${type} under ${schema}`).toEqual(expected);
    }
  });

  it.each(CROSS_HEADER_SCHEMAS)(
    'IfcBuildingElement and IfcBuiltElement are the same question under %s',
    async (schema) => {
      // IFC4X3 renamed `IfcBuildingElement` to `IfcBuiltElement`. Both spellings
      // have to reach the same rows, or a file's header decides whether a
      // caller's own spelling works: the three slabs, the wall, and the
      // IFC4X3-only course (furniture and strata are neither).
      const expected = [70, 71, 72, 77, 78];
      expect(await idsByType(schema, 'IfcBuildingElement'), `IfcBuildingElement/${schema}`).toEqual(expected);
      expect(await idsByType(schema, 'IfcBuiltElement'), `IfcBuiltElement/${schema}`).toEqual(expected);
    },
  );
});

/**
 * Expanding an abstract type must not walk out of the product branch.
 *
 * `IfcRoot` is the ancestor of everything with a GlobalId — occurrences, but
 * also `IfcPropertySet`, every `IfcRel*` and every `*Type`. Expanding it whole
 * turned `byType('IfcRoot')` into "every rooted record in the file" (223 rows
 * on `infra-bridge.ifc`, 36 of them `IfcRelDefinesByProperties`), and the
 * untyped branch of this same backend has always answered with
 * `isProductType` only. A caller then hands those rows to `storey()` or
 * `group_by`, which are written against products.
 *
 * The requested type itself is never gated, so asking for a property set or a
 * relationship by name still works — that caller said what they wanted.
 */
const BRANCH_MODEL = ifcFile(`#70= IFCWALL('WALL00000000000000000X',$,'Wall',$,$,$,$,'tag',$);
#71= IFCWALLTYPE('WALT00000000000000000X',$,'Wall type',$,$,$,$,$,$,.STANDARD.);
#72= IFCPROPERTYSET('PSET00000000000000000X',$,'Pset_Test',$,(#73));
#73= IFCPROPERTYSINGLEVALUE('P',$,IFCLABEL('v'),$);
#74= IFCRELDEFINESBYPROPERTIES('RDBP00000000000000000X',$,$,$,(#70),#72);`, 'IFC4');

const loadBranchModel = () => loadInlineModel(BRANCH_MODEL, 'supertype-branch');

describe('an abstract-root expansion stays inside the product branch', () => {
  it('byType("IfcRoot") answers with products only, not property sets or relationships', async () => {
    const bim = await loadBranchModel();
    const types = bim.query().byType('IfcRoot').toArray().map((e) => e.type).sort();
    expect(types).not.toContain('IfcPropertySet');
    expect(types).not.toContain('IfcRelDefinesByProperties');
    expect(types).not.toContain('IfcWallType');
    expect(types).toContain('IfcWall');
  });

  it('byType("IfcObjectDefinition") does not sweep in type objects', async () => {
    // The untyped branch holds type objects back so a query answers with
    // occurrences; the typed branch has to agree with it.
    const bim = await loadBranchModel();
    const types = bim.query().byType('IfcObjectDefinition').toArray().map((e) => e.type);
    expect(types).toContain('IfcWall');
    expect(types).not.toContain('IfcWallType');
  });

  it('byType("IfcPropertySet") still finds the property set — the gate never drops the requested type', async () => {
    const bim = await loadBranchModel();
    const result = bim.query().byType('IfcPropertySet').toArray();
    expect(result.map((e) => e.type)).toEqual(['IfcPropertySet']);
  });

  it('byType("IfcWallType") still finds the type object', async () => {
    const bim = await loadBranchModel();
    expect(bim.query().byType('IfcWallType').toArray().map((e) => e.type)).toEqual(['IfcWallType']);
  });

  it('byType("IfcBuildingElementType") keeps its own subtypes — the gate is a branch, not a ban', async () => {
    // A caller asking for an abstract TYPE supertype meant its subtypes just
    // as much as one asking for IfcBuildingElement did. Gating on
    // "is a product" alone would answer 0 here.
    const bim = await loadBranchModel();
    expect(bim.query().byType('IfcBuildingElementType').toArray().map((e) => e.type)).toEqual(['IfcWallType']);
  });
});
