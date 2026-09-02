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

describe('byType resolves per the model\'s own schema version (IFC4X3)', () => {
  it('byType("IfcBuiltElement") resolves on an IFC4X3 model (renamed from IfcBuildingElement)', async () => {
    const bim = await loadInlineModel(IFC4X3_MODEL, 'supertype-ifc4x3');
    const result = bim.query().byType('IfcBuiltElement').toArray();
    expect(result.length).toBe(2);
  });
});
