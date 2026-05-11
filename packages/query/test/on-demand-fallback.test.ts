/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for issue #577.
 *
 * `parseColumnar` populates `onDemandPropertyMap` / `onDemandQuantityMap`
 * and intentionally leaves the pre-parsed property/quantity tables empty.
 * The query layer must fall back to the on-demand extractors so users get
 * real data back from `includeProperties()` / `includeQuantities()`.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import { IfcQuery } from '../src/ifc-query.js';

async function parseFixture(ifc: string) {
  const source = new TextEncoder().encode(ifc);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: Array<{
    expressId: number;
    type: string;
    byteOffset: number;
    byteLength: number;
    lineNumber: number;
  }> = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0), entityRefs, {});
}

describe('QueryResultEntity on-demand fallback (issue #577)', () => {
  const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,'REI60',$);
#21=IFCPROPERTYSINGLEVALUE('IsExternal',$,.T.,$);
#30=IFCPROPERTYSET('pset-guid',#1,'Pset_WallCommon',$,(#20,#21));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);
#50=IFCQUANTITYLENGTH('Length',$,$,5.0);
#51=IFCQUANTITYAREA('NetSideArea',$,$,12.5);
#60=IFCELEMENTQUANTITY('qto-guid',#1,'Qto_WallBaseQuantities',$,$,(#50,#51));
#70=IFCRELDEFINESBYPROPERTIES('qto-rel-guid',#1,$,$,(#10),#60);`;

  it('pre-parsed property/quantity tables are empty after parseLite', async () => {
    const store = await parseFixture(ifc);
    expect(store.properties.count).toBe(0);
    expect(store.quantities?.count ?? 0).toBe(0);
    expect(store.onDemandPropertyMap?.get(10)).toBeDefined();
    expect(store.onDemandQuantityMap?.get(10)).toBeDefined();
  });

  it('QueryResultEntity.properties falls back to the on-demand map', async () => {
    const store = await parseFixture(ifc);
    const query = new IfcQuery(store);
    const [wall] = query.ofType('IfcWallStandardCase').execute();
    expect(wall).toBeDefined();

    const psets = wall.properties;
    expect(psets).toHaveLength(1);
    expect(psets[0].name).toBe('Pset_WallCommon');
    expect(psets[0].properties.map((p) => p.name).sort()).toEqual(['FireRating', 'IsExternal']);
  });

  it('QueryResultEntity.quantities falls back to the on-demand map', async () => {
    const store = await parseFixture(ifc);
    const query = new IfcQuery(store);
    const [wall] = query.ofType('IfcWallStandardCase').execute();

    const qsets = wall.quantities;
    expect(qsets).toHaveLength(1);
    expect(qsets[0].name).toBe('Qto_WallBaseQuantities');
    const byName = Object.fromEntries(qsets[0].quantities.map((q) => [q.name, q.value]));
    expect(byName.Length).toBe(5.0);
    expect(byName.NetSideArea).toBe(12.5);
  });

  it('includeProperties() / includeQuantities() eagerly populate results', async () => {
    const store = await parseFixture(ifc);
    const query = new IfcQuery(store);
    const results = query
      .ofType('IfcWallStandardCase')
      .includeProperties()
      .includeQuantities()
      .execute();

    expect(results).toHaveLength(1);
    const [wall] = results;
    expect(wall.properties.length).toBe(1);
    expect(wall.quantities.length).toBe(1);

    const json = wall.toJSON() as {
      properties: { name: string }[];
      quantities?: { name: string }[];
    };
    expect(json.properties[0].name).toBe('Pset_WallCommon');
    expect(json.quantities?.[0].name).toBe('Qto_WallBaseQuantities');
  });

  it('getProperty() reads values from the on-demand map', async () => {
    const store = await parseFixture(ifc);
    const query = new IfcQuery(store);
    const [wall] = query.ofType('IfcWallStandardCase').execute();

    expect(wall.getProperty('Pset_WallCommon', 'FireRating')).toBe('REI60');
    expect(wall.getProperty('Pset_WallCommon', 'IsExternal')).toBe(true);
    expect(wall.getProperty('Pset_WallCommon', 'NoSuchProp')).toBeNull();
  });
});
