/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `listCondition` (#6190): the Rules side of the Lists adapter. The Lists
 * engine decides what the predicate means (the viewer parity test pins that
 * against `executeList`); these pin what Rules owns: the saved shape is
 * guarded, the host matcher is what answers, a model without one fails
 * loudly, and a rule set cannot carry one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules, evaluateFilterRulesFederated } from './filter-evaluate.js';
import { evaluateFilterGroups, evaluateFilterGroupsFederated } from './filter-evaluate-groups.js';
import { isFilterRule, Rule } from './filter-rules.js';
import { parseRuleSetFile } from '../rule-set/rule-set-io.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall000000000000000010',$,'A',$,$,$,$,$,$);
#20=IFCWALL('0Wall000000000000000020',$,'B',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const zone = Rule.listCondition({ source: 'zone', psetName: 'zs-1', propertyName: 'Straddles', operator: 'equals', value: 'true' });

describe('listCondition rules (#6190)', () => {
  it('accepts the saved Lists shape and rejects fields the Lists engine cannot read', () => {
    assert.equal(isFilterRule(zone), true);
    assert.equal(isFilterRule({ ...zone, inherit: 'aggregation' }), true);
    assert.equal(isFilterRule({ ...zone, source: 'volume' }), false);
    assert.equal(isFilterRule({ ...zone, operator: 'eq' }), false);
    assert.equal(isFilterRule({ ...zone, value: null }), false);
    assert.equal(isFilterRule({ ...zone, psetName: 7 }), false);
    assert.equal(isFilterRule({ ...zone, inherit: 'parent' }), false);
  });

  it('asks the model\'s matcher, per element, inside AND and OR', async () => {
    const store = await parse();
    const asked: Array<[number, string]> = [];
    const listConditions = (id: number, rule: typeof zone) => { asked.push([id, rule.source]); return id === 20; };
    const and = evaluateFilterRules('m', store, [zone], 'AND', { candidateExpressIds: [10, 20], listConditions });
    assert.deepEqual(and.map((e) => e.expressId), [20]);
    assert.deepEqual(asked, [[10, 'zone'], [20, 'zone']]);
    const or = await evaluateFilterRulesFederated([{ id: 'm', store, listConditions }], [zone, Rule.name('eq', 'A')], 'OR', {
      candidateExpressIdsByModel: new Map([['m', [10, 20]]]),
    });
    assert.deepEqual(or.map((e) => e.expressId).sort(), [10, 20]);
  });

  it('fails loudly on a model with no matcher instead of matching nothing', async () => {
    const store = await parse();
    assert.throws(() => evaluateFilterRules('m', store, [zone], 'AND', { candidateExpressIds: [10] }), /Lists zone condition/);
  });

  it('fails before evaluating when a cheaper failing rule comes first (review finding on #6249)', async () => {
    const store = await parse();
    // `ifcType` is cheaper and fails on every wall, so AND short-circuits before `zone` is ever reached.
    const rules = [Rule.ifcType(['IfcDoor']), zone];
    assert.throws(() => evaluateFilterRules('m', store, rules, 'AND'), /Lists zone condition/);
    await assert.rejects(evaluateFilterRulesFederated([{ id: 'm', store }], rules, 'AND'), /model "m"/);
    // A second group holding the rule is refused before the first group returns rows.
    const groups = [{ combinator: 'AND' as const, rules: [Rule.name('eq', 'A')] }, { combinator: 'AND' as const, rules }];
    assert.throws(() => evaluateFilterGroups('m', store, groups), /Lists zone condition/);
    await assert.rejects(evaluateFilterGroupsFederated([{ id: 'm', store }], groups), /Lists zone condition/);
    // Positive control: with a matcher the same filter runs and the cheap rule excludes everything.
    assert.deepEqual(evaluateFilterRules('m', store, rules, 'AND', { listConditions: () => true }), []);
  });

  it('is refused by the rule-set format, which has no Lists provider to run it', () => {
    const block = (rules: unknown[]) => ({ groups: [{ rules, combinator: 'AND' }], authoredAs: 'chips' });
    const parsed = parseRuleSetFile({
      version: 1, name: 'x',
      rules: [{
        id: 'r', name: 'r', applicability: block([zone]),
        requirement: { kind: 'element', block: block([{ kind: 'name', op: 'eq', value: 'A' }]) },
      }],
    });
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.error, /listCondition/);
  });
});
