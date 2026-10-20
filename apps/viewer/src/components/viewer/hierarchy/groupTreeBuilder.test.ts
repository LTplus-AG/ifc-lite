/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { buildGroupTree } from './groupTreeBuilder.js';
import { filterNodes } from './treeDataBuilder.js';

const ALL = { has: () => true };
const FIXTURE = `
#10=IFCSPACE('0aaaaaaaaaaaaaaaaaaaa1',$,'1.01',$,$,$,$,$,$,$,$);
#11=IFCSPACE('0aaaaaaaaaaaaaaaaaaaa2',$,'1.02',$,$,$,$,$,$,$,$);
#12=IFCSPACE('0aaaaaaaaaaaaaaaaaaaa3',$,'1.03',$,$,$,$,$,$,$,$);
#20=IFCZONE('0bbbbbbbbbbbbbbbbbbbb1',$,'Unit A',$,$,$);
#21=IFCZONE('0bbbbbbbbbbbbbbbbbbbb2',$,'Rental units',$,$,$);
#22=IFCZONE('0bbbbbbbbbbbbbbbbbbbb3',$,'Unit B',$,$,$);
#23=IFCZONE('0bbbbbbbbbbbbbbbbbbbb4',$,'Energy',$,$,$);
#30=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc1',$,$,$,(#10,#11),$,#20);
#31=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc2',$,$,$,(#20,#22),$,#21);
#32=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc3',$,$,$,(#11,#12),$,#22);
#33=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc4',$,$,$,(#20),$,#23);
`;
async function parse(data = FIXTURE) {
  const source = `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;`;
  return new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer as ArrayBuffer, { disableWorkerScan: true });
}

beforeEach(() => federationRegistry.clear());
afterEach(() => {
  federationRegistry.clear();
  useViewerStore.setState({ models: new Map() });
});

describe('nested group graph (#7870)', () => {
  it('renders nested zones once per parent with transitive geometry and direct counts', async () => {
    const store = await parse();
    const tree = buildGroupTree(new Map(), store, ALL, false, new Set([10, 11, 12]));
    assert.deepEqual(tree.filter(n => n.depth === 0).map(n => n.name), ['Energy', 'Rental units']);
    const rental = tree.find(n => n.name === 'Rental units')!;
    const children = tree.slice(tree.indexOf(rental) + 1);
    assert.deepEqual(children.map(n => [n.name, n.depth, n.type]), [
      ['Unit A', 1, 'group'], ['1.01', 2, 'group-member'], ['1.02', 2, 'group-member'],
      ['Unit B', 1, 'group'], ['1.02', 2, 'group-member'], ['1.03', 2, 'group-member'],
    ]);
    assert.deepEqual([...rental.globalIds].sort(), [10, 11, 12]);
    assert.equal(rental.elementCount, 2);
    assert.deepEqual(rental.memberGlobalIds, [20, 22]);
    assert.equal(tree.filter(n => n.name === 'Unit A').length, 2, 'shared child appears under both parents');
    assert.equal(new Set(tree.map(n => n.id)).size, tree.length, 'occurrence ids are unique');
    assert.ok(children[0].hasChildren);
    assert.deepEqual(buildGroupTree(new Map(), store, new Set(), false, new Set([10, 11, 12]))
      .find(n => n.name === 'Rental units')?.globalIds, rental.globalIds, 'collapse does not change isolation');
    const onlyRental = buildGroupTree(new Map(), store, new Set([rental.id]), false, new Set([10, 11, 12]));
    assert.deepEqual(onlyRental.filter(n => n.depth === 1).map(n => [n.name, n.hasChildren]), [['Unit A', true], ['Unit B', true]]);
    assert.deepEqual(filterNodes(tree, '1.03').map(n => n.name), ['Rental units', 'Unit B', '1.03']);
  });

  it('resolves geometry across sub-filter boundaries without hiding matching roots', async () => {
    const store = await parse(FIXTURE + `
#24=IFCSYSTEM('0bbbbbbbbbbbbbbbbbbbb5',$,'System',$,$);
#34=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc5',$,$,$,(#21),$,#24);`);
    const all = buildGroupTree(new Map(), store, ALL, false, new Set([10, 11, 12]));
    assert.deepEqual(all.find(n => n.name === 'System')?.globalIds.sort(), [10, 11, 12]);
    const zones = buildGroupTree(new Map(), store, ALL, false, new Set([10, 11, 12]), 'zones');
    assert.ok(zones.some(n => n.name === 'Rental units' && n.depth === 0));
  });

  it('uses effective assignments for rewritten nested membership', async () => {
    const store = await parse();
    const view = new MutablePropertyView(null, 'legacy');
    view.setAttribute(31, 'RelatedObjects', '#22');
    view.deleteEntity(33);
    const tree = buildGroupTree(new Map(), store, ALL, false, new Set([10, 11, 12]), 'all', () => view);
    assert.deepEqual(tree.filter(n => n.depth === 0).map(n => n.name), ['Rental units', 'Unit A']);
    assert.deepEqual(tree.find(n => n.name === 'Rental units')?.globalIds.sort(), [11, 12]);
  });

  it('keeps rootless cycles browsable and resolves every reachable geometric member', async () => {
    const store = await parse(FIXTURE + `
#34=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc5',$,$,$,(#21,#20),$,#20);
#35=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc6',$,$,$,(#23),$,#21);`);
    const tree = buildGroupTree(new Map(), store, ALL, false, new Set([10, 11, 12]));
    assert.equal(tree.filter(n => n.depth === 0).length, 1);
    assert.ok(tree.length < 30);
    for (const row of tree.filter(n => n.type === 'group' && n.name !== 'Unit B')) {
      assert.deepEqual(row.globalIds.sort(), [10, 11, 12]);
    }
    assert.ok(tree.some(n => n.type === 'group' && !n.hasChildren), 'cycle closes at a non-expandable occurrence');
  });

  it('does not promote a cycle descendant to a duplicate root because it sorts first', async () => {
    const store = await parse(FIXTURE + `
#34=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc5',$,$,$,(#21),$,#21);
#35=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc6',$,$,$,(#23),$,#21);`);
    // "Energy" sorts before "Rental units", but is downstream of its cycle.
    const tree = buildGroupTree(new Map(), store, ALL, false, new Set([10, 11, 12]));
    assert.deepEqual(tree.filter(n => n.depth === 0).map(n => n.name), ['Rental units']);
    assert.ok(tree.some(n => n.name === 'Energy' && n.depth === 1));
  });

  for (const count of [1, 2]) {
    it(`keeps global ids correct with ${count} registered model(s)`, async () => {
      const models = new Map<string, FederatedModel>();
      const geo = new Set<number>();
      for (let i = 1; i <= count; i++) {
        const idOffset = useViewerStore.getState().registerModelOffset(`nested-${i}`, 100);
        const model = { ...fixtureModel(`nested-${i}`, { idOffset }), maxExpressId: 100, ifcDataStore: await parse() };
        models.set(model.id, model);
        for (const id of [10, 11, 12]) geo.add(idOffset + id);
      }
      useViewerStore.setState({ ...fixtureModels(...models.values()) });
      const tree = buildGroupTree(models, null, ALL, count > 1, geo);
      const rentals = tree.filter(n => n.name === 'Rental units');
      assert.equal(rentals.length, count);
      for (let i = 0; i < count; i++) {
        const offset = models.get(rentals[i].modelId!)!.idOffset;
        assert.deepEqual(rentals[i].globalIds.sort(), [offset + 10, offset + 11, offset + 12]);
      }
    });
  }

  it('processes a composed IFCX store shared by model layers once', async () => {
    const store = await parse();
    const a = { ...fixtureModel('layer-a'), ifcDataStore: store };
    const b = { ...fixtureModel('layer-b'), ifcDataStore: store };
    const models = fixtureModels(a, b).models;
    const tree = buildGroupTree(models, null, ALL, true, new Set());
    assert.equal(tree.filter(n => n.name === 'Rental units').length, 1);
  });

  it('bounds exponential DAG projection and reports truncation', async (t) => {
    const lines = ["#1=IFCSPACE('space',$,'Room',$,$,$,$,$,$,$,$);"];
    for (let i = 2; i <= 35; i++) {
      const children = i < 4 ? '#1' : `#${2 * Math.floor(i / 2) - 2},#${2 * Math.floor(i / 2) - 1}`;
      lines.push(`#${i}=IFCZONE('zone${i}',$,'Zone ${i}',$,$,$);`);
      lines.push(`#${i + 100}=IFCRELASSIGNSTOGROUP('rel${i}',$,$,$,(${children}),$,#${i});`);
    }
    const store = await parse(lines.join('\n'));
    const warning = t.mock.method(console, 'warn', () => {});
    const tree = buildGroupTree(new Map(), store, ALL, false, new Set([1]));
    assert.equal(tree.length, 50_000);
    assert.equal(warning.mock.callCount(), 1);
    assert.match(warning.mock.calls[0].arguments[0], /truncated/);
    assert.deepEqual(tree[0].globalIds, [1], 'geometry is complete despite the projection limit');
  });

  it('walks a long acyclic chain without recursive stack growth', async () => {
    const lines = ["#1=IFCSPACE('space',$,'Room',$,$,$,$,$,$,$,$);"];
    for (let i = 2; i <= 3000; i++) {
      lines.push(`#${i}=IFCZONE('zone${i}',$,'Zone ${i}',$,$,$);`);
      lines.push(`#${i + 4000}=IFCRELASSIGNSTOGROUP('rel${i}',$,$,$,(#${i - 1}),$,#${i});`);
    }
    const store = await parse(lines.join('\n'));
    const tree = buildGroupTree(new Map(), store, ALL, false, new Set([1]));
    assert.equal(tree.length, 3000);
    assert.equal(tree.at(-1)?.depth, 2999);
    assert.ok(tree.filter(n => n.type === 'group').every(n => n.globalIds.length === 1 && n.globalIds[0] === 1));
  });
});
