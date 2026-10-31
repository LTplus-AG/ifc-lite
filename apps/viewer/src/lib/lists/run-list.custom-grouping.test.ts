/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8425 end to end over parsed IFC: a list run with a `customGrouping`
 * column shows each element's group from a saved Lens, a `customGrouping`
 * scope rule keeps exactly the rows whose column says that group, and a
 * live rename moves a wall between groups in both.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcTypeEnum } from '@ifc-lite/data';
import type { Lens } from '@ifc-lite/lens';
import type { ListDefinition } from '@ifc-lite/lists';
import { Rule, type FilterGroup, type FilterRule } from '@ifc-lite/rules';
import { evaluatorModelsFromState } from '../model-tags/evaluator-models.js';
import { createListDataProvider } from './adapter.js';
import { runListFederated } from './run-list.js';

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
#103= IFCWALL('0Wal300000000000000003',$,'W-Int-2',$,$,#40,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
}

const and = (...rules: FilterRule[]): FilterGroup => ({ combinator: 'AND', rules });
const lensRule = (id: string, name: string, groups: FilterGroup[]) => ({ id, name, enabled: true, groups, action: 'colorize' as const, color: '#E53935' });
const FACADE: Lens = {
  id: 'lens-facade', name: 'Facade',
  rules: [lensRule('r1', 'Exterior', [and(Rule.name('startsWith', 'W-Ext'))]), lensRule('r2', 'Interior', [and(Rule.ifcType(['IfcWall'], 'in'))])],
};

function list(groups: FilterGroup[]): ListDefinition {
  return {
    id: 'l', name: 'L', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], groups,
    columns: [
      { id: 'name', source: 'attribute', propertyName: 'Name' },
      // Stale name, live id: the column follows a renamed Lens through its id.
      { id: 'g', source: 'customGrouping', psetName: 'lens-facade', propertyName: 'Old facade name' },
    ],
  };
}

async function run(groups: FilterGroup[], view?: MutablePropertyView): Promise<string[]> {
  const store = await parse();
  const state = {
    models: new Map([['m', { id: 'm', sourceFingerprint: 'fp', sourceContentHash: 'h', ifcDataStore: store }]]),
    modelTags: new Map(), modelTagAssignments: new Map<string, ReadonlySet<string>>(),
    mutationViews: view ? new Map([['m', view]]) : undefined,
    savedLenses: [FACADE],
  };
  const pairs = [{ modelId: 'm', store, provider: createListDataProvider(store, 'M', undefined, view), mutationView: view }];
  const result = await runListFederated(list(groups), pairs, state, { evaluatorModels: evaluatorModelsFromState(state) });
  return result.rows.map((row) => `${row.values[0]}=${row.values[1]}`).sort();
}

describe('custom grouping column in a list run (#8425)', () => {
  it('shows each element group and agrees with the customGrouping scope rule', async () => {
    assert.deepEqual(await run([]), ['W-Ext-1=Exterior', 'W-Int-1=Interior', 'W-Int-2=Interior']);
    assert.deepEqual(await run([and(Rule.customGrouping({ name: 'Facade' }, 'in', ['Interior']))]), ['W-Int-1=Interior', 'W-Int-2=Interior']);
  });

  it('a live rename moves the wall in the column and in the scope rule alike', async () => {
    const view = new MutablePropertyView(null, 'm');
    view.setAttribute(102, 'Name', 'W-Ext-2');
    assert.deepEqual(await run([and(Rule.customGrouping({ name: 'Facade' }, 'in', ['Exterior']))], view),
      ['W-Ext-1=Exterior', 'W-Ext-2=Exterior']);
  });
});
