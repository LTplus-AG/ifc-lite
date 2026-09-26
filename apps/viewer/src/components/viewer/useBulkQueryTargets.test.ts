/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { emptyFilterGroup, type FilterGroup } from '@ifc-lite/rules';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { resolveBulkQueryIds } from './useBulkQueryTargets.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('classes.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#10=IFCPROJECT('0Proj00000000000000001',$,'Project',$,$,$,$,$,$);
#1=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,$);
#2=IFCWALLSTANDARDCASE('0Wall00000000000000002',$,'Standard wall',$,$,$,$,$,$);
#3=IFCCURTAINWALL('0Wall00000000000000003',$,'Curtain wall',$,$,$,$,$,$);
#4=IFCWALLTYPE('0Wall00000000000000004',$,'Wall type',$,$,$,$,$,$,.STANDARD.);
#5=IFCSTAIR('0Stair0000000000000005',$,'Stair',$,$,$,$,$,$);
#6=IFCSTAIRFLIGHT('0Stair0000000000000006',$,'Flight',$,$,$,$,$,$,$,$,$,$);
ENDSEC;END-ISO-10303-21;`;

const group = (type: string): FilterGroup[] => [{
  combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: [type] }],
}];

describe('#5898 Bulk Rule targets over parsed IFC', () => {
  it('matches exact IFC classes in one model without sweeping name fragments', async () => {
    const bytes = new TextEncoder().encode(IFC);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    useViewerStore.setState({
      ...fixtureModels({ ...fixtureModel('a'), ifcDataStore: store }),
      mutationViews: new Map(),
    });
    const state = useViewerStore.getState();
    assert.ok((await resolveBulkQueryIds(state, 'a', [emptyFilterGroup()])).includes(1),
      'an untouched Query keeps the prior whole-model default');
    assert.deepEqual(await resolveBulkQueryIds(state, 'a', group('IfcWall')), [1]);
    assert.deepEqual(await resolveBulkQueryIds(state, 'a', group('IfcCurtainWall')), [3]);
    assert.deepEqual(await resolveBulkQueryIds(state, 'a', group('IfcStair')), [5]);
    assert.deepEqual(await resolveBulkQueryIds(state, 'a', group('IfcStairFlight')), [6]);
  });

  it('unions groups while keeping the requested model boundary', async () => {
    const bytes = new TextEncoder().encode(IFC);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    useViewerStore.setState({
      ...fixtureModels(
        { ...fixtureModel('a'), ifcDataStore: store },
        { ...fixtureModel('b', { idOffset: 1_000_000 }), ifcDataStore: store },
      ),
      mutationViews: new Map(),
    });
    const groups = [...group('IfcWall'), ...group('IfcStair')];
    assert.deepEqual(await resolveBulkQueryIds(useViewerStore.getState(), 'a', groups), [1, 5]);
    assert.deepEqual(await resolveBulkQueryIds(useViewerStore.getState(), 'b', groups), [1, 5]);
  });

  it('queries the live mutation overlay before applying another edit', async () => {
    const bytes = new TextEncoder().encode(IFC);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const view = new MutablePropertyView(store.properties, 'a');
    configureMutationView(view, store);
    view.setProperty(1, 'Pset_Test', 'Rating', 'High', PropertyValueType.String);
    useViewerStore.setState({
      ...fixtureModels({ ...fixtureModel('a'), ifcDataStore: store }),
      mutationViews: new Map([['a', view]]),
    });
    const groups: FilterGroup[] = [{ combinator: 'AND', rules: [{
      kind: 'property', setName: 'Pset_Test', propertyName: 'Rating', op: 'eq', value: 'High',
    }] }];
    assert.deepEqual(await resolveBulkQueryIds(useViewerStore.getState(), 'a', groups), [1]);
    view.setProperty(1, 'Pset_Test', 'Rating', 'Low', PropertyValueType.String);
    assert.deepEqual(await resolveBulkQueryIds(useViewerStore.getState(), 'a', groups), []);
  });
});
