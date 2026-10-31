/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8425: a saved rule-based Lens is a custom grouping for every evaluator run
 * built from store state. The test goes through `evaluatorModelsFromState`,
 * the one builder search, clash, lists, validation, bulk edit and charts use,
 * so a consumer cannot miss the definitions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { Lens } from '@ifc-lite/lens';
import { evaluateFilterGroupsFederated, Rule, type FilterGroup, type FilterRule } from '@ifc-lite/rules';
import { evaluatorModelsFromState, type ModelTagState } from '../model-tags/evaluator-models.js';
import { customGroupingsFromLenses, isGroupingLens } from './custom-groupings.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#101= IFCWALL('0Wal100000000000000001',$,'W-Ext-1',$,$,#40,$,$,$);
#102= IFCWALL('0Wal200000000000000002',$,'W-Int-1',$,$,#40,$,$,$);
#103= IFCSLAB('0Sla300000000000000003',$,'S-1',$,$,#40,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
}

const and = (...rules: FilterRule[]): FilterGroup => ({ combinator: 'AND', rules });
const lensRule = (id: string, name: string, groups: FilterGroup[], enabled = true) =>
  ({ id, name, enabled, groups, action: 'colorize' as const, color: '#E53935' });

const DISCIPLINES: Lens = {
  id: 'lens-disc',
  name: 'Disciplines',
  rules: [
    lensRule('r1', 'Structure', [and(Rule.ifcType(['IfcSlab'], 'in')), and(Rule.name('startsWith', 'W-Ext'))]),
    lensRule('r2', 'Architecture', [and(Rule.ifcType(['IfcWall'], 'in'))]),
  ],
};

function state(store: IfcDataStore, savedLenses: Lens[], view?: MutablePropertyView): ModelTagState {
  return {
    models: new Map([['m', { id: 'm', sourceFingerprint: 'fp', sourceContentHash: 'h', ifcDataStore: store }]]),
    modelTags: new Map(),
    modelTagAssignments: new Map(),
    mutationViews: view ? new Map([['m', view]]) : undefined,
    savedLenses,
  };
}

async function run(s: ModelTagState, rule: FilterRule): Promise<number[]> {
  const rows = await evaluateFilterGroupsFederated(evaluatorModelsFromState(s), [and(rule)], { limit: Number.POSITIVE_INFINITY });
  return rows.map((r) => r.expressId).sort((a, b) => a - b);
}

describe('rule-based Lenses as custom groupings (#8425)', () => {
  it('a saved Lens answers customGrouping rules in any run built from store state, first match wins', async () => {
    const store = await parse();
    const s = state(store, [DISCIPLINES]);
    assert.deepEqual(await run(s, Rule.customGrouping({ name: 'Disciplines' }, 'in', ['Structure'])), [101, 103]);
    assert.deepEqual(await run(s, Rule.customGrouping({ name: 'Disciplines' }, 'in', ['Architecture'])), [102]);
  });

  it('reads live edits: renaming a wall moves it between groups', async () => {
    const store = await parse();
    const view = new MutablePropertyView(null, 'm');
    view.setAttribute(102, 'Name', 'W-Ext-2');
    assert.deepEqual(await run(state(store, [DISCIPLINES], view), Rule.customGrouping({ name: 'Disciplines' }, 'in', ['Structure'])), [101, 102, 103]);
  });

  it('without saved Lenses the rule is unresolved and matches nothing, never everything', async () => {
    const store = await parse();
    assert.deepEqual(await run(state(store, []), Rule.customGrouping({ name: 'Disciplines' }, 'notIn', ['Structure'])), []);
  });

  it('only rule-based Lenses with a named rule are groupings; unreadable rules keep their name but match nothing', () => {
    const auto: Lens = { id: 'auto', name: 'By class', rules: [], autoColor: { source: 'ifcType' } };
    const unnamed: Lens = { id: 'blank', name: 'Blank', rules: [lensRule('r', ' ', [])] };
    const legacy: Lens = {
      id: 'legacy', name: 'Legacy',
      rules: [{ ...lensRule('r', 'Old', []), unreadableLegacy: { criteria: {}, reason: 'test' } }],
    };
    assert.deepEqual([DISCIPLINES, auto, unnamed, legacy].filter(isGroupingLens).map((l) => l.id), ['lens-disc', 'legacy']);
    assert.deepEqual(customGroupingsFromLenses([legacy], [])[0].members, [{ name: 'Old', enabled: true, filter: null }]);
  });
});
