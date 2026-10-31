/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `customGrouping` rules (#8425): an element belongs to the FIRST enabled
 * member of a user-authored grouping it matches, and filters, clash sets and
 * lists pick groups by name.
 *
 *   #101 wall "W-Ext-1"   Structure (first member) AND Architecture (second): Structure wins
 *   #102 wall "W-Int-1"   Architecture
 *   #103 slab "S-1"       Structure
 *   #104 door "D-1"       Architecture
 *   #105 window "F-1"     in no group
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import { evaluateFilterGroupsFederated } from './filter-evaluate-groups.js';
import { isFilterRule, Rule, type FilterRule } from './filter-rules.js';
import type { FilterGroup } from './filter-groups.js';
import {
  customGroupOf, unresolvedCustomGrouping, type CustomGroupingDefinition,
} from './filter-custom-grouping.js';

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
#104= IFCDOOR('0Doo400000000000000004',$,'D-1',$,$,#40,$,$,$,$,$,$);
#105= IFCWINDOW('0Win500000000000000005',$,'F-1',$,$,#40,$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const group = (...rules: FilterRule[]): FilterGroup => ({ combinator: 'AND', rules });
const PRODUCTS: FilterRule = Rule.ifcType(['IfcWall', 'IfcSlab', 'IfcDoor', 'IfcWindow'], 'in');

const DISCIPLINES: CustomGroupingDefinition = {
  id: 'g-disc',
  name: 'Disciplines',
  members: [
    { name: 'Structure', enabled: true, filter: [group(Rule.ifcType(['IfcSlab'], 'in')), group(Rule.name('startsWith', 'W-Ext'))] },
    { name: 'Architecture', enabled: true, filter: [group(Rule.ifcType(['IfcWall', 'IfcDoor'], 'in'))] },
  ],
};

function ids(store: IfcDataStore, rules: FilterRule[], groupings: readonly CustomGroupingDefinition[] | null = [DISCIPLINES]): number[] {
  return evaluateFilterRules('m', store, rules, 'AND', { customGroupings: groupings ?? undefined })
    .map((r) => r.expressId).sort((a, b) => a - b);
}

describe('customGrouping rule (#8425)', () => {
  it('gives each element to the first member it matches, so groups never overlap', async () => {
    const store = await parse();
    const disc = { name: 'Disciplines' };
    assert.deepEqual(ids(store, [Rule.customGrouping(disc, 'in', ['Structure'])]), [101, 103]);
    // W-Ext-1 also matches Architecture's filter, but Structure precedes it.
    assert.deepEqual(ids(store, [Rule.customGrouping(disc, 'in', ['architecture'])]), [102, 104]);
    assert.deepEqual(ids(store, [Rule.customGrouping(disc, 'in', ['Structure', 'Architecture'])]), [101, 102, 103, 104]);
  });

  it('notIn keeps ungrouped elements as well as other groups', async () => {
    const store = await parse();
    assert.deepEqual(ids(store, [PRODUCTS, Rule.customGrouping({ name: 'Disciplines' }, 'notIn', ['Structure'])]), [102, 104, 105]);
  });

  it('a disabled member keeps its name defined, has no members, and passes precedence on', async () => {
    const store = await parse();
    const disabled: CustomGroupingDefinition = {
      ...DISCIPLINES, members: [{ ...DISCIPLINES.members[0], enabled: false }, DISCIPLINES.members[1]],
    };
    assert.deepEqual(ids(store, [Rule.customGrouping({ name: 'Disciplines' }, 'in', ['Structure'])], [disabled]), []);
    assert.deepEqual(ids(store, [Rule.customGrouping({ name: 'Disciplines' }, 'in', ['Architecture'])], [disabled]), [101, 102, 104]);
  });

  it('resolves by id when it exists here, else by a unique name; a stale id still finds the name', async () => {
    const store = await parse();
    const renamed = { ...DISCIPLINES, name: 'Trades' };
    assert.deepEqual(ids(store, [Rule.customGrouping({ id: 'g-disc', name: 'Disciplines' }, 'in', ['Structure'])], [renamed]), [101, 103]);
    assert.deepEqual(ids(store, [Rule.customGrouping({ id: 'from-another-project', name: ' disciplines ' }, 'in', ['Structure'])]), [101, 103]);
  });

  it('an unknown grouping, an ambiguous name or an unknown group matches nothing under either op', async () => {
    const store = await parse();
    const twin = { ...DISCIPLINES, id: 'g-twin' };
    for (const op of ['in', 'notIn'] as const) {
      assert.deepEqual(ids(store, [PRODUCTS, Rule.customGrouping({ name: 'Nope' }, op, ['Structure'])]), [], `unknown grouping, ${op}`);
      assert.deepEqual(ids(store, [PRODUCTS, Rule.customGrouping({ name: 'Disciplines' }, op, ['Structure'])], [DISCIPLINES, twin]), [], `ambiguous, ${op}`);
      assert.deepEqual(ids(store, [PRODUCTS, Rule.customGrouping({ name: 'Disciplines' }, op, ['Structure', 'MEP'])]), [], `unknown group, ${op}`);
    }
    assert.deepEqual(unresolvedCustomGrouping({ grouping: { name: 'Nope' }, values: ['x'] }, [DISCIPLINES]), { grouping: true });
    assert.deepEqual(unresolvedCustomGrouping({ grouping: { name: 'Disciplines' }, values: ['Structure', 'MEP'] }, [DISCIPLINES]), { groups: ['MEP'] });
    assert.equal(unresolvedCustomGrouping({ grouping: { name: 'Disciplines' }, values: ['Structure'] }, [DISCIPLINES]), null);
  });

  it('refuses a run without definitions before any element is read, even behind a cheaper failing rule', async () => {
    const store = await parse();
    const rules = [Rule.ifcType(['IfcBeam'], 'in'), Rule.customGrouping({ name: 'Disciplines' }, 'in', ['Structure'])];
    assert.throws(() => ids(store, rules, null), /needs the host's grouping definitions/);
  });

  it('a member may use another grouping; a grouping reaching itself throws', async () => {
    const store = await parse();
    const loadBearing: CustomGroupingDefinition = {
      id: 'g-lb', name: 'Load bearing',
      members: [{ name: 'Yes', enabled: true, filter: [group(Rule.customGrouping({ name: 'Disciplines' }, 'in', ['Structure']))] }],
    };
    assert.deepEqual(ids(store, [Rule.customGrouping({ name: 'Load bearing' }, 'in', ['Yes'])], [DISCIPLINES, loadBearing]), [101, 103]);

    const loop: CustomGroupingDefinition = {
      id: 'g-loop', name: 'Loop',
      members: [{ name: 'A', enabled: true, filter: [group(Rule.customGrouping({ name: 'Loop' }, 'in', ['A']))] }],
    };
    assert.throws(() => ids(store, [Rule.customGrouping({ name: 'Loop' }, 'in', ['A'])], [loop]), /refers to itself/);
  });

  it('honours the grouping scope and works across federated models', async () => {
    const [a, b] = [await parse(), await parse()];
    const scoped: CustomGroupingDefinition = { ...DISCIPLINES, inScope: (modelId) => modelId === 'b' };
    const rows = await evaluateFilterGroupsFederated(
      [{ id: 'a', store: a, customGroupings: [scoped] }, { id: 'b', store: b, customGroupings: [scoped] }],
      [group(Rule.customGrouping({ name: 'Disciplines' }, 'in', ['Structure']))],
      { limit: Number.POSITIVE_INFINITY },
    );
    assert.deepEqual(rows.map((r) => `${r.modelId}:${r.expressId}`).sort(), ['b:101', 'b:103']);
  });

  it('customGroupOf names the element group, and the rule survives the JSON guard', async () => {
    const store = await parse();
    const byName = (expressId: number) => customGroupOf(DISCIPLINES, 'm', expressId,
      (filter) => filter.some((g) => evaluateFilterRules('m', store, g.rules, g.combinator, { candidateExpressIds: [expressId] }).length > 0));
    assert.deepEqual([101, 102, 103, 104, 105].map(byName), ['Structure', 'Architecture', 'Structure', 'Architecture', undefined]);

    const rule = Rule.customGrouping({ id: 'g-disc', name: 'Disciplines' }, 'in', ['Structure']);
    assert.equal(isFilterRule(JSON.parse(JSON.stringify(rule))), true);
    assert.equal(isFilterRule({ ...rule, grouping: { id: 3, name: 'x' } }), false);
    assert.equal(isFilterRule({ ...rule, op: 'hasAny' }), false);
  });
});
