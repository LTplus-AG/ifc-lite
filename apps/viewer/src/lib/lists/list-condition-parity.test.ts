/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6190: every Lists-only predicate mode, carried in a Rules group as a
 * `listCondition` rule, keeps exactly the rows `executeList` keeps for the
 * same saved condition. Parsed IFC, one and two models, a live mutation
 * overlay on the second, and zone assignment plus zone volume data on both.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcTypeEnum } from '@ifc-lite/data';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { executeList, type ListDefinition, type PropertyCondition } from '@ifc-lite/lists';
import { Rule, type FilterGroup, type ModelTag } from '@ifc-lite/rules';
import { zoneSetRevision, type ZoneAssignment, type ZoneSet } from '../zones/index.js';
import type { ElementApportionment } from '../zones/apportionment.js';
import { createListDataProvider, type ZoneListContext } from './adapter.js';
import { runListFederated, type ModelProviderPair } from './run-list.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Proj000000000000000001',$,'Tower',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000002',$,'Site A',$,$,$,$,$,$,$,$,$,$,$);
#3=IFCBUILDING('0Bldg000000000000000003',$,'Building A',$,$,$,$,$,$,$,$,$);
#4=IFCBUILDINGSTOREY('0Stry000000000000000004',$,'Level 1',$,$,$,$,$,$,0.);
#5=IFCSPACE('0Spce000000000000000005',$,'Room 1',$,$,$,$,$,$,$,$);
#6=IFCRELAGGREGATES('0Agg0000000000000000006',$,$,$,#1,(#2));
#7=IFCRELAGGREGATES('0Agg0000000000000000007',$,$,$,#2,(#3));
#8=IFCRELAGGREGATES('0Agg0000000000000000008',$,$,$,#3,(#4));
#9=IFCRELAGGREGATES('0Agg0000000000000000009',$,$,$,#4,(#5));
#10=IFCWALL('0Wall000000000000000010',$,'Wall A',$,$,$,$,'T-10',$);
#20=IFCWALL('0Wall000000000000000020',$,'Wall B',$,$,$,$,$,$);
#30=IFCWALL('0Wall000000000000000030',$,'Part wall',$,$,$,$,$,$);
#35=IFCWALL('0Wall000000000000000035',$,'Loose wall',$,$,$,$,$,$);
#40=IFCELEMENTASSEMBLY('0Asm0000000000000000040',$,'Assembly',$,$,$,$,$,$,$);
#41=IFCRELAGGREGATES('0Agg0000000000000000041',$,$,$,#40,(#30));
#42=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('ASM'),$);
#43=IFCPROPERTYSET('0Pset000000000000000043',$,'Pset_Assembly',$,(#42));
#44=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000044',$,$,$,(#40),#43);
#45=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cnt000000000000000045',$,$,$,(#10,#40),#4);
#46=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cnt000000000000000046',$,$,$,(#20),#5);
#50=IFCQUANTITYVOLUME('NetVolume',$,$,2.5,$);
#51=IFCELEMENTQUANTITY('0Qto0000000000000000051',$,'Qto_WallBaseQuantities',$,$,(#50));
#52=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000052',$,$,$,(#10),#51);
#60=IFCMATERIAL('Concrete',$,'Structural');
#61=IFCMATERIALLAYER(#60,0.2,$,'Core',$,$,$);
#62=IFCMATERIALLAYERSET((#61),'Wall layers',$);
#63=IFCRELASSOCIATESMATERIAL('0Mat0000000000000000063',$,$,$,(#10),#62);
#64=IFCMATERIAL('Brick',$,$);
#65=IFCRELASSOCIATESMATERIAL('0Mat0000000000000000065',$,$,$,(#20),#64);
#70=IFCCLASSIFICATION('NBS',$,$,'Uniclass',$,$,$);
#71=IFCCLASSIFICATIONREFERENCE($,'Ss_25','Walls',#70,$,$);
#72=IFCRELASSOCIATESCLASSIFICATION('0Cls0000000000000000072',$,$,$,(#10),#71);
#80=IFCWALLTYPE('0Type00000000000000080',$,'WT-1',$,$,$,$,$,$,.NOTDEFINED.);
#81=IFCRELDEFINESBYTYPE('0Rel000000000000000081',$,$,$,(#10,#20),#80);
ENDSEC;
END-ISO-10303-21;`;

const ZONE_SET: ZoneSet = {
  id: 'zs-sections', name: 'Sections', visible: true, createdAt: 0, updatedAt: 0,
  zones: [
    { id: 'z-a', name: 'Zone A', center: [0, 0, 0], size: [1, 1, 1], rotationY: 0 },
    { id: 'z-b', name: 'Zone B', center: [2, 0, 0], size: [1, 1, 1], rotationY: 0 },
  ],
};

const home = (zoneId: string | null, touched: string[] = zoneId ? [zoneId] : []): ZoneAssignment => ({
  zoneId, zoneName: ZONE_SET.zones.find((z) => z.id === zoneId)?.name ?? null,
  straddles: touched.length > 1, touchedZoneIds: touched,
});
const split = (shares: Array<[string, number]>): ElementApportionment => {
  const whole = shares.reduce((sum, [, v]) => sum + v, 0);
  return {
    wholeVolumeM3: whole, outsideVolumeM3: 0, outsideFraction: 0, overlapping: false,
    shares: shares.map(([zoneId, volumeM3]) => ({
      zoneId, zoneName: ZONE_SET.zones.find((z) => z.id === zoneId)!.name, volumeM3, fraction: volumeM3 / whole,
    })),
  } as ElementApportionment;
};

/** Zone data keyed by federated id, as the viewer's assignment sync stores it. */
function zoneContext(offset: number, assignments: Record<number, ZoneAssignment>, volumes: Record<number, ElementApportionment>): ZoneListContext {
  const key = (id: number) => id + offset;
  return {
    zoneSets: [ZONE_SET],
    zoneAssignments: new Map(Object.entries(assignments).map(([id, a]) => [key(Number(id)), { [ZONE_SET.id]: a }])),
    apportionment: new Map([[ZONE_SET.id, {
      revision: zoneSetRevision(ZONE_SET), computedAt: 0, elapsedMs: 0, refused: new Map(),
      byElement: new Map(Object.entries(volumes).map(([id, v]) => [key(Number(id)), v])),
    }]]),
    volumeSiScale: 1,
    getWorldPosition: (id) => ({ x: id, y: 0, z: 0 }),
    toGlobalId: key,
  };
}

async function parse() {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Model 1 as loaded; model 2 a second parse with live edits and its own zone results. */
async function models(): Promise<ModelProviderPair[]> {
  const first = await parse();
  const second = await parse();
  const view = new MutablePropertyView(second.properties, 'm2');
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(second, id));
  view.setAttribute(10, 'Name', 'Renamed wall');
  view.setProperty(35, 'Pset_Assembly', 'Mark', 'EDITED');
  view.setQuantity(35, 'Qto_WallBaseQuantities', 'NetVolume', 9);
  view.deleteEntity(20);
  return [
    { modelId: 'm1', store: first, provider: createListDataProvider(first, 'Model 1.ifc', zoneContext(0,
      { 10: home('z-a'), 20: home('z-a', ['z-a', 'z-b']), 30: home(null) },
      { 10: split([['z-a', 2]]), 20: split([['z-a', 1.5], ['z-b', 0.5]]) })) },
    { modelId: 'm2', store: second, mutationView: view, provider: createListDataProvider(second, 'Model 2.ifc', zoneContext(1_000_000,
      { 10: home('z-b'), 30: home('z-a', ['z-a', 'z-b']), 35: home('z-a') },
      { 30: split([['z-a', 0.4], ['z-b', 3]]), 35: split([['z-a', 5]]) }), view) },
  ];
}

const state = {
  models: new Map([['m1', {}], ['m2', {}]]),
  modelTags: new Map<string, ModelTag>(),
  modelTagAssignments: new Map<string, ReadonlySet<string>>(),
};
const definition = (groups: FilterGroup[]): ListDefinition => ({
  id: 'walls', name: 'Walls', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], groups,
  columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
});
const rows = (list: ReadonlyArray<{ modelId: string; entityId: number }>) =>
  list.map(({ modelId, entityId }) => `${modelId}:${entityId}`).sort();

/** One condition per mode the scoped compatibility editor offered, plus the executable remainder. */
const MODES: Record<string, PropertyCondition> = {
  'zone name': { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Zone', operator: 'equals', value: 'Zone A' },
  'zone name of a straddler': { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Zone', operator: 'contains', value: 'Zone B' },
  'zone straddles': { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Straddles', operator: 'equals', value: 'true' },
  'zone volume (mesh)': { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Volume (mesh)', operator: 'gt', value: '1.8' },
  'zone volume breakdown': { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Volume breakdown (mesh)', operator: 'contains', value: 'Zone B' },
  'zone of an unknown set': { source: 'zone', psetName: 'zs-deleted', propertyName: 'Zone', operator: 'exists', value: '' },
  'spatial container': { source: 'spatial', propertyName: 'Container', operator: 'equals', value: 'Room 1' },
  'spatial storey': { source: 'spatial', propertyName: 'Storey', operator: 'equals', value: 'Level 1' },
  'spatial building': { source: 'spatial', propertyName: 'Building', operator: 'equals', value: 'Building A' },
  'spatial site': { source: 'spatial', propertyName: 'Site', operator: 'notEquals', value: 'Site B' },
  'spatial project': { source: 'spatial', propertyName: 'Project', operator: 'contains', value: 'tow' },
  'quantity presence': { source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetVolume', operator: 'exists', value: '' },
  'quantity comparison': { source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetVolume', operator: 'lt', value: '5' },
  'material presence': { source: 'material', propertyName: 'Material', operator: 'exists', value: '' },
  'material layer name': { source: 'material', propertyName: 'Material', operator: 'equals', value: 'core' },
  'material exclusion': { source: 'material', propertyName: 'Material', operator: 'notEquals', value: 'Brick' },
  'classification code': { source: 'classification', propertyName: 'Classification', operator: 'contains', value: 'ss_' },
  'model filename equals': { source: 'model', propertyName: 'Model', operator: 'equals', value: 'Model 2.ifc' },
  'model filename contains': { source: 'model', propertyName: 'Model', operator: 'contains', value: '1.IFC' },
  'pseudo-attribute GlobalId substring': { source: 'attribute', propertyName: 'GlobalId', operator: 'contains', value: 'Wall00000000000000003' },
  'pseudo-attribute Type presence': { source: 'attribute', propertyName: 'Type', operator: 'exists', value: '' },
  'pseudo-attribute Class': { source: 'attribute', propertyName: 'Class', operator: 'equals', value: 'IfcWall' },
  'attribute Tag presence': { source: 'attribute', propertyName: 'Tag', operator: 'exists', value: '' },
  'live-edited Name': { source: 'attribute', propertyName: 'Name', operator: 'contains', value: 'renamed' },
  'inherited property': { source: 'property', psetName: 'Pset_Assembly', propertyName: 'Mark', operator: 'equals', value: 'ASM', inherit: 'aggregation' },
  'inherited property presence': { source: 'property', psetName: 'Pset_Assembly', propertyName: 'Mark', operator: 'exists', value: '', inherit: 'aggregation' },
  'regex property name': { source: 'property', psetName: '/^Pset_Ass/', propertyName: 'Mark', operator: 'exists', value: '' },
  'world coordinate': { source: 'geometry', propertyName: 'X', operator: 'gte', value: '30' },
};

/** Modes that cannot split this fixture: one project per file, one class in scope, and a
 * zone set that no longer exists (durable id, so it matches nothing rather than another set). */
const UNIFORM: Record<string, 'all' | 'none'> = {
  'spatial project': 'all', 'pseudo-attribute Class': 'all', 'zone of an unknown set': 'none',
};

describe('#6190 listCondition rules match executeList on parsed IFC', () => {
  for (const [mode, condition] of Object.entries(MODES)) {
    it(`${mode}: same rows at one and two models`, async () => {
      const pairs = await models();
      const rule = Rule.listCondition(condition);
      for (const scope of [pairs.slice(0, 1), pairs]) {
        const scopedState = { ...state, models: new Map(scope.map(({ modelId }) => [modelId, {}])) };
        const expected = scope.flatMap(({ modelId, provider }) =>
          executeList({ ...definition([]), legacyConditions: [condition] }, provider, modelId).rows);
        const actual = await runListFederated(definition([{ combinator: 'AND', rules: [rule] }]), scope, scopedState);
        assert.deepEqual(rows(actual.rows), rows(expected), `${mode} at ${scope.length} model(s)`);
      }
      // The fixture must discriminate: across both models some wall is kept and some dropped.
      const all = await runListFederated(definition([]), pairs, state);
      const kept = await runListFederated(definition([{ combinator: 'AND', rules: [rule] }]), pairs, state);
      const uniform = UNIFORM[mode];
      if (uniform) assert.equal(kept.rows.length, uniform === 'all' ? all.rows.length : 0, mode);
      else assert.ok(kept.rows.length > 0 && kept.rows.length < all.rows.length, `${mode} keeps ${kept.rows.length} of ${all.rows.length} walls`);
    });
  }

  it('reads the live overlay: the deleted wall is gone and edited values count', async () => {
    const pairs = await models();
    const all = await runListFederated(definition([]), pairs, state);
    assert.deepEqual(rows(all.rows), ['m1:10', 'm1:20', 'm1:30', 'm1:35', 'm2:10', 'm2:30', 'm2:35']);
    const edited = await runListFederated(definition([{ combinator: 'AND', rules: [Rule.listCondition(MODES['quantity comparison'])] }]), pairs, state);
    // m2:35's NetVolume 9 exists only in the overlay and fails `lt 5`; m1:10's parsed 2.5 passes.
    assert.deepEqual(rows(edited.rows), ['m1:10', 'm2:10']);
  });

  it('a Lists predicate now composes under OR with a canonical rule', async () => {
    const pairs = await models();
    const zone = MODES['zone straddles'];
    const groups: FilterGroup[] = [{ combinator: 'OR', rules: [Rule.listCondition(zone), Rule.name('eq', 'Loose wall')] }];
    const result = await runListFederated(definition(groups), pairs, state);
    const straddlers = pairs.flatMap(({ modelId, provider }) =>
      executeList({ ...definition([]), legacyConditions: [zone] }, provider, modelId).rows);
    assert.deepEqual(rows(result.rows), [...new Set([...rows(straddlers), 'm1:35', 'm2:35'])].sort());
  });
});
