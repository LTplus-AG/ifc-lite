/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { BUILTIN_LENSES, matchesCriteria, type LensCriteria } from '@ifc-lite/lens';
import { evaluateFilterGroups } from '@ifc-lite/rules';
import { createLensDataProvider } from './adapter.js';
import { legacyCriteriaToFilterGroups } from './legacy-criteria-to-filter-groups.js';

// A real parsed IFC store, rather than a mock evaluator, catches differences
// in class names, property extraction, and group candidate enumeration.
const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('lens-5896','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall000000000000000010',$,'Fire wall',$,$,$,$,$,$);
#11=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('60'),$);
#12=IFCPROPERTYSET('0Pset000000000000000012',$,'Pset_WallCommon',$,(#11));
#13=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000013',$,$,$,(#10),#12);
#20=IFCDOOR('0Door000000000000000020',$,'Door',$,$,$,$,$,$,$,$,$,$,$);
#30=IFCWALLSTANDARDCASE('0Wall000000000000000030',$,'Plain wall',$,$,$,$,$,$);
#40=IFCCOLUMN('0Col000000000000000040',$,'Column',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;
const IDS = [10, 20, 30, 40];

async function fixture() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer);
  const provider = createLensDataProvider(new Map(), store);
  const before = (criteria: LensCriteria) => IDS.filter((id) => matchesCriteria(criteria, id, provider));
  const after = (criteria: LensCriteria) => {
    const converted = legacyCriteriaToFilterGroups(criteria);
    assert.equal(converted.status, 'readable', JSON.stringify(criteria));
    if (converted.status !== 'readable') return [];
    return evaluateFilterGroups('legacy', store, converted.groups, {
      candidateExpressIds: IDS, limit: Number.POSITIVE_INFINITY,
    }).map((row) => row.expressId).sort((a, b) => a - b);
  };
  return { before, after };
}

describe('#5896 legacy lens criteria migration', () => {
  it('preserves every built-in manual rule on one parsed IFC store', async () => {
    const { before, after } = await fixture();
    for (const lens of BUILTIN_LENSES) for (const rule of lens.rules) {
      assert.deepEqual(after(rule.criteria), before(rule.criteria), `${lens.name}: ${rule.name}`);
    }
  });

  it('preserves a nested imported rule after bounded DNF normalization', async () => {
    const { before, after } = await fixture();
    const saved: LensCriteria = {
      type: 'or', conditions: [
        { type: 'and', conditions: [
          { type: 'ifcType', ifcType: 'IfcWall' },
          { type: 'property', propertySet: 'Pset_WallCommon', propertyName: 'FireRating',
            operator: 'equals', propertyValue: '60' },
        ] },
        { type: 'ifcType', ifcType: 'IfcDoor' },
      ],
    };
    assert.deepEqual(before(saved), [10, 20]);
    assert.deepEqual(after(saved), before(saved));
  });

  it('preserves GlobalId equality and Name substring matching', async () => {
    const { before, after } = await fixture();
    const saved: LensCriteria = {
      type: 'attribute', attributeName: 'GlobalId', operator: 'equals',
      attributeValue: '0Wall000000000000000010',
    };
    assert.deepEqual(before(saved), [10]);
    assert.deepEqual(after(saved), before(saved));
    const byName: LensCriteria = {
      type: 'attribute', attributeName: 'Name', operator: 'contains', attributeValue: 'FIRE',
    };
    assert.deepEqual(before(byName), [10]);
    assert.deepEqual(after(byName), before(byName));
  });

  it('warns for unrepresentable semantics and explosive DNF instead of changing matches', () => {
    for (const criteria of [
      { type: 'material', materialName: 'Concrete' },
      { type: 'classification', classificationSystem: 'Uni' },
      { type: 'quantity', quantitySet: 'Qto_WallBaseQuantities', quantityName: 'NetVolume', operator: 'equals', quantityValue: '1' },
      { type: 'model', modelId: 'runtime-id' },
      { type: 'attribute', attributeName: 'Name', operator: 'equals', attributeValue: 'Wall' },
      { type: 'property', propertySet: 'Pset_WallCommon', propertyName: 'FireRating', operator: 'contains' },
    ] as LensCriteria[]) {
      assert.equal(legacyCriteriaToFilterGroups(criteria).status, 'unreadable', criteria.type);
    }
    let explosive: LensCriteria = { type: 'ifcType', ifcType: 'IfcWall' };
    for (let i = 0; i < 6; i++) {
      explosive = { type: 'and', conditions: [explosive, {
        type: 'or', conditions: [
          { type: 'ifcType', ifcType: 'IfcDoor' },
          { type: 'ifcType', ifcType: 'IfcColumn' },
        ],
      }] };
    }
    assert.equal(legacyCriteriaToFilterGroups(explosive).status, 'unreadable');
  });
});
