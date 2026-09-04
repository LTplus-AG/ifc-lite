/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A clash set defined as an ADVANCED FILTER (#3902).
 *
 * The whole point of the design is that a clash set and a search filter are
 * resolved by the same evaluator, so these tests drive the real one
 * (`evaluateFilterRulesFederated`) over a real parsed store rather than a
 * stub: if the two ever drift, the drift is in this file's expectations.
 *
 * Fixture:
 *  - Wall-A (#100), external (Pset_WallCommon.IsExternal = .T.)
 *  - Wall-B (#110), internal (IsExternal = .F.)
 *  - Duct-C (#120), no property sets at all
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { clashMemberKey, rulesFromPresets, type ClashRule } from '@ifc-lite/clash';
import { Rule } from '../search/filter-rules.js';
import {
  parseClashSetFilter,
  activeClashSetFilter,
  describeClashSetFilter,
  resolveClashSetFilter,
  withResolvedClashSetFilters,
  type ClashSetFilter,
} from './set-filter.js';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#100=IFCWALL('Wall00000000000000001A',$,'Wall-A',$,$,$,$,$,.SOLIDWALL.);
#110=IFCWALL('Wall00000000000000001B',$,'Wall-B',$,$,$,$,$,.SOLIDWALL.);
#120=IFCDUCTSEGMENT('Duct00000000000000001C',$,'Duct-C',$,$,$,$,$,$);
#200=IFCPROPERTYSET('Pset00000000000000001A',$,'Pset_WallCommon',$,(#201));
#201=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#210=IFCRELDEFINESBYPROPERTIES('Rdbp00000000000000001A',$,$,$,(#100),#200);
#220=IFCPROPERTYSET('Pset00000000000000002A',$,'Pset_WallCommon',$,(#221));
#221=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);
#230=IFCRELDEFINESBYPROPERTIES('Rdbp00000000000000002A',$,$,$,(#110),#220);
ENDSEC;
END-ISO-10303-21;
`;

async function buildStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(FIXTURE);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, {
    disableWorkerScan: true,
  }) as unknown as Promise<IfcDataStore>;
}

/** The viewer's federation mapping, in its simplest form: one model at offset 0. */
const toGlobalId = (_modelId: string, expressId: number): number => expressId;

async function models(): Promise<Array<{ id: string; store: IfcDataStore | null }>> {
  return [{ id: 'm1', store: await buildStore() }];
}

const filter = (combinator: 'AND' | 'OR', ...rules: ClashSetFilter['rules']): ClashSetFilter => ({
  combinator,
  rules,
});

describe('resolveClashSetFilter', () => {
  it('resolves a set defined by class AND property value', async () => {
    const members = await resolveClashSetFilter(
      await models(),
      filter('AND', Rule.ifcType(['IfcWall']), Rule.property('Pset_WallCommon', 'IsExternal', 'eq', 'true')),
      toGlobalId,
    );
    // Wall-B is a wall but internal; Duct-C is neither.
    assert.deepEqual(members, [clashMemberKey('m1', 100)]);
  });

  it('widens across two rows joined by OR', async () => {
    const members = await resolveClashSetFilter(
      await models(),
      filter('OR', Rule.ifcType(['IfcDuctSegment']), Rule.property('Pset_WallCommon', 'IsExternal', 'eq', 'true')),
      toGlobalId,
    );
    assert.deepEqual(
      members.slice().sort(),
      [clashMemberKey('m1', 100), clashMemberKey('m1', 120)].sort(),
    );
  });

  it('resolves an unsatisfiable filter to an EMPTY set, not to everything', async () => {
    const members = await resolveClashSetFilter(
      await models(),
      filter('AND', Rule.ifcType(['IfcWall']), Rule.ifcType(['IfcDuctSegment'])),
      toGlobalId,
    );
    assert.deepEqual(members, []);
  });

  it('refuses a set that hit the resolve cap instead of clashing a truncated one', async () => {
    // The evaluator stops scanning at its limit, so a capped set is silently
    // smaller than the user asked for and the run would report fewer clashes
    // than the model has, with nothing to say so.
    const loaded = await models();
    await assert.rejects(
      () => resolveClashSetFilter(loaded, filter('AND', Rule.ifcType(['IfcWall'])), toGlobalId, { limit: 1 }),
      /matched more than/,
    );
  });

  it('keys members by (model, global id) so a federated model stays distinct', async () => {
    const members = await resolveClashSetFilter(
      await models(),
      filter('AND', Rule.name('contains', 'Duct-C')),
      (modelId, expressId) => (modelId === 'm1' ? expressId + 1_000_000 : expressId),
    );
    assert.deepEqual(members, [clashMemberKey('m1', 1_000_120)]);
  });
});

describe('withResolvedClashSetFilters', () => {
  const rule: ClashRule = { id: 'r1', name: 'Walls vs ducts', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' };

  it('replaces only the sides that carry a filter', async () => {
    const [out] = await withResolvedClashSetFilters(
      [rule],
      [{ id: 'r1', filterA: filter('AND', Rule.property('Pset_WallCommon', 'IsExternal', 'eq', 'true')) }],
      await models(),
      toGlobalId,
    );
    assert.deepEqual(out.membersA, [clashMemberKey('m1', 100)]);
    assert.equal(out.membersB, undefined, 'B has no filter and must keep resolving through its selector');
    assert.equal(out.a, 'IfcWall', 'the selector is kept as the rule’s description of itself');
  });

  it('leaves a rule with no filters byte-for-byte alone', async () => {
    const [out] = await withResolvedClashSetFilters([rule], [], await models(), toGlobalId);
    assert.deepEqual(out, rule);
  });

  it('an EMPTY-rule filter is not a filter — the selector still decides', async () => {
    // A preset whose filter the user cleared must go back to its selector,
    // not run over nothing.
    const [out] = await withResolvedClashSetFilters(
      [rule],
      [{ id: 'r1', filterA: filter('AND') }],
      await models(),
      toGlobalId,
    );
    assert.equal(out.membersA, undefined);
  });

  it('resolves one filter ONCE however many sides reuse it', async () => {
    // Reusing "external walls" as the A side of several rules is how a rule
    // set is written; each resolution is a full federation scan that parses
    // property sets on demand. The shared array is the observable proof.
    const shared = filter('AND', Rule.ifcType(['IfcWall']));
    const out = await withResolvedClashSetFilters(
      [rule, { ...rule, id: 'r2' }],
      [
        { id: 'r1', filterA: shared, filterB: shared },
        { id: 'r2', filterA: { combinator: 'AND', rules: [Rule.ifcType(['IfcWall'])] } },
      ],
      await models(),
      toGlobalId,
    );
    assert.equal(out[0].membersA, out[0].membersB, 'both sides of one rule share the filter');
    assert.equal(out[0].membersA, out[1].membersA, 'an equal filter on another rule resolves once too');
  });

  it('matches a rule to its preset by the id rulesFromPresets carries over', async () => {
    // The join is by id; if `rulesFromPresets` ever stopped copying the preset
    // id onto the rule, every filter would silently fail open to its selector.
    const preset = {
      id: 'custom-1',
      name: 'External walls vs ducts',
      description: '',
      severity: 'major' as const,
      selectorA: 'IfcWall',
      selectorB: 'IfcDuct*',
    };
    const [built] = rulesFromPresets([preset], 'hard');
    assert.equal(built.id, preset.id);
    const [out] = await withResolvedClashSetFilters(
      [built],
      [{ ...preset, filterA: filter('AND', Rule.property('Pset_WallCommon', 'IsExternal', 'eq', 'true')) }],
      await models(),
      toGlobalId,
    );
    assert.deepEqual(out.membersA, [clashMemberKey('m1', 100)]);
  });

  it('carries an unsatisfiable filter through as an empty member list', async () => {
    const [out] = await withResolvedClashSetFilters(
      [rule],
      [{ id: 'r1', filterA: filter('AND', Rule.ifcType(['IfcNoSuchThing'])) }],
      await models(),
      toGlobalId,
    );
    assert.deepEqual(out.membersA, [], 'not undefined: undefined would fall back to the selector');
  });
});

describe('parseClashSetFilter (persisted shape)', () => {
  it('accepts a stored filter and drops rules it does not recognise', () => {
    const parsed = parseClashSetFilter({
      combinator: 'OR',
      rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }, { kind: 'nonsense' }, 42],
    });
    assert.equal(parsed?.combinator, 'OR');
    assert.deepEqual(parsed?.rules, [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }]);
  });

  it('is undefined for anything that is not a filter, including a rule-less one', () => {
    // A preset saved before #3902 has no filter fields at all — every read
    // path must land here rather than on a half-built object.
    assert.equal(parseClashSetFilter(undefined), undefined);
    assert.equal(parseClashSetFilter(null), undefined);
    assert.equal(parseClashSetFilter('IfcWall'), undefined);
    assert.equal(parseClashSetFilter({ combinator: 'AND', rules: [] }), undefined);
    assert.equal(parseClashSetFilter({ combinator: 'AND', rules: 'nope' }), undefined);
  });

  it('defaults an unknown combinator to AND', () => {
    const parsed = parseClashSetFilter({ combinator: 'XOR', rules: [{ kind: 'name', op: 'contains', value: 'a' }] });
    assert.equal(parsed?.combinator, 'AND');
  });
});

describe('describeClashSetFilter', () => {
  it('summarises the rules for the rule list', () => {
    assert.equal(
      describeClashSetFilter(filter('OR', Rule.ifcType(['IfcWall']), Rule.name('contains', 'A'))),
      '2 rules · OR',
    );
    assert.equal(describeClashSetFilter(filter('AND', Rule.ifcType(['IfcWall']))), '1 rule');
  });

  it('reports an inactive filter as no filter', () => {
    assert.equal(activeClashSetFilter(undefined), undefined);
    assert.equal(activeClashSetFilter(filter('AND')), undefined);
    const active = filter('AND', Rule.ifcType(['IfcWall']));
    assert.equal(activeClashSetFilter(active), active);
  });
});
