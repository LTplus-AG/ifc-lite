/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateLens, type LensDataProvider } from '@ifc-lite/lens';
import type { EvaluatorModel } from '@ifc-lite/rules';
import type { GroupLens } from './evaluate-lens-groups.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('lens-5896','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall000000000000000010',$,'Wall',$,$,$,$,$,$);
#20=IFCCOLUMN('0Col000000000000000020',$,'Column',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parsedStore(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer);
}

const lens: GroupLens = {
  id: 'group-lens', name: 'Shared groups', rules: [
    { id: 'walls', name: 'Walls', enabled: true, action: 'colorize', color: '#ff0000',
      groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }] },
    { id: 'columns', name: 'Columns', enabled: true, action: 'hide', color: '#000000',
      groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcColumn'] }] }] },
  ],
};

function provider(stores: ReadonlyMap<string, { store: IfcDataStore; offset: number }>): LensDataProvider {
  return {
    getEntityCount: () => stores.size * 2,
    forEachEntity: (visit) => {
      for (const [modelId, { offset }] of stores) {
        visit(offset + 10, modelId);
        visit(offset + 20, modelId);
      }
    },
    getEntityType: (globalId) => {
      for (const { store, offset } of stores.values()) {
        if (globalId === offset + 10 || globalId === offset + 20) {
          return store.entities.getTypeName(globalId - offset);
        }
      }
      return undefined;
    },
    getPropertyValue: () => undefined,
    getPropertySets: () => [],
  };
}

describe('#5896 shared Lens groups over parsed IFC', () => {
  for (const count of [1, 2]) {
    it(`maps selected local IDs to global IDs for ${count} model(s)`, async () => {
      const groupEvaluator = await import('./evaluate-lens-groups.js').catch(() => null);
      assert.ok(groupEvaluator?.evaluateLensGroups, 'the shared Lens evaluator must be available');
      const stores = new Map<string, { store: IfcDataStore; offset: number }>();
      const models: EvaluatorModel[] = [];
      const offsets = new Map<string, { idOffset: number }>();
      for (let index = 0; index < count; index++) {
        const id = `model-${index}`;
        const store = await parsedStore();
        const offset = index * 1000;
        stores.set(id, { store, offset });
        offsets.set(id, { idOffset: offset });
        models.push({ id, store });
      }
      const matched = await groupEvaluator.evaluateLensGroups(lens, models, offsets, new Set());
      assert.deepEqual([...matched.get('walls') ?? []], [...stores.values()].map(({ offset }) => offset + 10));
      assert.deepEqual([...matched.get('columns') ?? []], [...stores.values()].map(({ offset }) => offset + 20));

      // The action engine consumes the real evaluator's global-ID sets. Its
      // staged v1 type still requires criteria; the final stack removes them.
      const staged = { ...lens, rules: lens.rules.map((rule) => ({
        ...rule, criteria: { type: 'ifcType' as const, ifcType: 'IfcColumn' },
      })) };
      const result = evaluateLens(staged, provider(stores), matched);
      assert.deepEqual([...result.hiddenIds], [...stores.values()].map(({ offset }) => offset + 20));
      assert.deepEqual([...result.ruleCounts], [['walls', count], ['columns', count]]);
      for (const { offset } of stores.values()) {
        assert.deepEqual(result.colorMap.get(offset + 10), [1, 0, 0, 1]);
        assert.equal(result.colorMap.has(offset + 20), false);
      }
    });
  }
});
