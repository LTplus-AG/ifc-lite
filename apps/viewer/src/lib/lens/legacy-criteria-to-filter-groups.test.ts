/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { BUILTIN_LENSES } from '@ifc-lite/lens';
import { evaluateFilterGroups } from '@ifc-lite/rules';
import type { PersistedV1LensCriteria as LensCriteria } from './persisted-v1-criteria.js';

async function loadConverter() {
  const module = await import('./legacy-criteria-to-filter-groups.js').catch(() => null);
  assert.ok(module?.legacyCriteriaToFilterGroups, 'the legacy Lens migration must be available');
  return module.legacyCriteriaToFilterGroups;
}

// A real parsed IFC store, rather than a mock evaluator, catches differences
// in class names, property extraction, and group candidate enumeration.
const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('lens-5896','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall000000000000000010',$,'Fire wall',$,$,$,$,'W-10',$);
#11=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('60'),$);
#12=IFCPROPERTYSET('0Pset000000000000000012',$,'Pset_WallCommon',$,(#11));
#13=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000013',$,$,$,(#10),#12);
#14=IFCQUANTITYLENGTH('Height',$,$,2.4,$);
#15=IFCELEMENTQUANTITY('0Qto00000000000000015',$,'Qto_WallBaseQuantities',$,$,(#14));
#16=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000016',$,$,$,(#10),#15);
#20=IFCDOOR('0Door000000000000000020',$,'Door',$,$,$,$,'',2.1,$,$,$,$);
#30=IFCWALLSTANDARDCASE('0Wall000000000000000030',$,'Plain wall',$,$,$,$,$,$);
#40=IFCCOLUMN('0Col000000000000000040',$,'Column',$,$,$,$,$,$);
#50=IFCGROUP('0Group00000000000000050',$,'Fire crew',$,$);
#51=IFCRELASSIGNSTOGROUP('0Rel000000000000000051',$,$,$,(#10,#20),$,#50);
#52=IFCQUANTITYLENGTH('Height',$,$,3.2,$);
#53=IFCELEMENTQUANTITY('0Qto00000000000000053',$,'Qto_WallBaseQuantities',$,$,(#52));
#54=IFCWALLTYPE('0Type00000000000000054',$,'Tall wall type',$,$,(#53),$,$,$,.STANDARD.);
#55=IFCRELDEFINESBYTYPE('0Rel000000000000000055',$,$,$,(#30),#54);
ENDSEC;
END-ISO-10303-21;`;
const IDS = [10, 20, 30, 40];

async function fixture() {
  const legacyCriteriaToFilterGroups = await loadConverter();
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer);
  const after = (criteria: LensCriteria) => {
    const converted = legacyCriteriaToFilterGroups(criteria);
    assert.equal(converted.status, 'readable', JSON.stringify(criteria));
    if (converted.status !== 'readable') return [];
    return evaluateFilterGroups('legacy', store, converted.groups, {
      candidateExpressIds: IDS, limit: Number.POSITIVE_INFINITY,
    }).map((row) => row.expressId).sort((a, b) => a - b);
  };
  return { store, after };
}

describe('#5896 legacy lens criteria migration', () => {
  it('preserves every built-in manual rule on one parsed IFC store', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer);
    // Recorded from the v1 built-ins through matchesCriteria before the
    // migration. Keep the old selection sets independent of new group code.
    const expected: Record<string, number[]> = {
      'lens-structural:col': [40], 'lens-structural:beam': [],
      'lens-structural:slab': [], 'lens-structural:footing': [],
      'lens-envelope:roof': [], 'lens-envelope:curtwall': [],
      'lens-envelope:window': [], 'lens-envelope:door': [20],
      'lens-envelope:wall': [10, 30],
      'lens-openings:door': [20], 'lens-openings:window': [],
      'lens-openings:stair': [], 'lens-openings:ramp': [],
      'lens-openings:railing': [],
    };
    let seen = 0;
    for (const lens of BUILTIN_LENSES) for (const rule of lens.rules) {
      const key = `${lens.id}:${rule.id}`;
      assert.ok(Object.hasOwn(expected, key), `new built-in rule ${key} needs a v1 oracle`);
      assert.ok(rule.groups, `built-in rule ${key} must use shared groups`);
      assert.equal('criteria' in rule, false, `built-in rule ${key} must not ship retired v1 criteria`);
      const selected = evaluateFilterGroups('legacy', store, rule.groups, {
        candidateExpressIds: IDS, limit: Number.POSITIVE_INFINITY,
      }).map((row) => row.expressId).sort((a, b) => a - b);
      assert.deepEqual(selected, expected[key], key);
      seen++;
    }
    assert.equal(seen, Object.keys(expected).length, 'all v1 built-in rules are still present');
  });

  it('preserves a nested imported rule after bounded DNF normalization', async () => {
    const { after } = await fixture();
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
    assert.deepEqual(after(saved), [10, 20]);
  });

  it('preserves GlobalId equality and Name substring matching', async () => {
    const { after } = await fixture();
    const saved: LensCriteria = {
      type: 'attribute', attributeName: 'GlobalId', operator: 'equals',
      attributeValue: '0Wall000000000000000010',
    };
    assert.deepEqual(after(saved), [10]);
    const byName: LensCriteria = {
      type: 'attribute', attributeName: 'Name', operator: 'contains', attributeValue: 'FIRE',
    };
    assert.deepEqual(after(byName), [10]);
  });

  it('preserves numeric quantity, type-inherited quantity, and group membership', async () => {
    const { after } = await fixture();
    for (const [criteria, expected] of [
      [{ type: 'quantity', quantitySet: 'Qto_WallBaseQuantities', quantityName: 'Height',
        operator: 'gt', quantityValue: '2' }, [10, 30]],
      [{ type: 'quantity', quantitySet: 'Qto_WallBaseQuantities', quantityName: 'Height',
        operator: 'gte', quantityValue: '3' }, [30]],
      [{ type: 'group', groupName: 'FIRE' }, [10, 20]],
      [{ type: 'group' }, [10, 20]],
    ] as [LensCriteria, number[]][]) {
      assert.deepEqual(after(criteria), expected, `converted ${criteria.type}`);
    }
  });

  it('preserves existence checks for a real property and a supported attribute', async () => {
    const { after } = await fixture();
    for (const criteria of [
      { type: 'property', propertySet: 'Pset_WallCommon', propertyName: 'FireRating', operator: 'exists' },
      { type: 'attribute', attributeName: 'Tag', operator: 'exists' },
    ] as LensCriteria[]) {
      assert.deepEqual(after(criteria), [10], `converted ${criteria.type}`);
    }
  });

  it('warns for derived Type and schema attributes absent from the old provider', async () => {
    const { store } = await fixture();
    const convert = await loadConverter();
    const derivedType: LensCriteria = { type: 'attribute', attributeName: 'Type',
      operator: 'equals', attributeValue: 'IfcDoor' };
    const schemaAttribute: LensCriteria = { type: 'attribute', attributeName: 'OverallHeight',
      operator: 'equals', attributeValue: '2.1' };
    const emptyTag: LensCriteria = { type: 'attribute', attributeName: 'Tag',
      operator: 'equals', attributeValue: '' };
    const notTag: LensCriteria = { type: 'attribute', attributeName: 'Tag',
      operator: 'ne', attributeValue: 'W-10' };
    // Recorded v1 results: Type derived one door; the provider could not
    // read schema-specific OverallHeight, and its blank Tag was absent.
    const genericAttributeIds = evaluateFilterGroups('legacy', store, [{
      rules: [{ kind: 'attribute', name: 'OverallHeight', op: 'eq', value: '2.1' }],
      combinator: 'AND',
    }], { candidateExpressIds: IDS, limit: Number.POSITIVE_INFINITY }).map((row) => row.expressId);
    assert.deepEqual(genericAttributeIds, [20], 'generic schema reader would broaden the saved lens');
    assert.equal(convert(derivedType).status, 'unreadable');
    assert.equal(convert(schemaAttribute).status, 'unreadable');
    assert.equal(convert(emptyTag).status, 'unreadable');
    assert.equal(convert(notTag).status, 'unreadable');
  });

  it('warns for unrepresentable semantics and explosive DNF instead of changing matches', async () => {
    const legacyCriteriaToFilterGroups = await loadConverter();
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
