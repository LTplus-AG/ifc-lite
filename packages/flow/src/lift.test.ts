/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { assemble, CrossProductTooLarge, planLift, type LiftInput } from './lift.js';
import type { PortDef } from './registry.js';
import { group, item, list, type EntityRef, type FlowData } from './values.js';

const port = (name: string, access: PortDef['type']['access'], extra: Partial<PortDef> = {}): PortDef => ({
  name,
  type: { kind: 'any', access },
  ...extra,
});

const ref = (globalId: string): EntityRef => ({ globalId });
const opts = { lacing: 'shortest' as const, maxCross: 1000 };

function inputs(...pairs: Array<[PortDef, FlowData | undefined]>): LiftInput[] {
  return pairs.map(([p, data]) => ({ port: p, data }));
}

describe('planLift — items and lists', () => {
  it('does not lift when every item port receives an item', () => {
    const plan = planLift(inputs([port('a', 'item'), item(1)], [port('b', 'item'), item(2)]), opts);
    expect(plan.lifted).toBe(false);
    expect(plan.lanes).toEqual([{ laneKey: null, branchKey: null, args: { a: 1, b: 2 }, nullLane: false }]);
  });

  it('a list port receives the whole list and does not lift', () => {
    const plan = planLift(inputs([port('xs', 'list'), list([1, 2, 3])]), opts);
    expect(plan.lifted).toBe(false);
    expect(plan.lanes[0].args).toEqual({ xs: [1, 2, 3] });
  });

  it('a list port receiving a single item sees a one-element list', () => {
    const plan = planLift(inputs([port('xs', 'list'), item(7)]), opts);
    expect(plan.lanes[0].args).toEqual({ xs: [7] });
  });

  it('a list of one on an item port is still a lane, not a broadcast', () => {
    const plan = planLift(inputs([port('a', 'item'), list([1])]), opts);
    expect(plan.lifted).toBe(true);
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0].laneKey).toBe('0');
  });

  it('shortest lacing stops at the shortest list and broadcasts single items', () => {
    const plan = planLift(inputs([port('a', 'item'), list([1, 2, 3])], [port('b', 'item'), list([10, 20])], [port('c', 'item'), item('k')]), opts);
    expect(plan.lanes.map((l) => l.args)).toEqual([
      { a: 1, b: 10, c: 'k' },
      { a: 2, b: 20, c: 'k' },
    ]);
  });

  it('longest lacing repeats the last element', () => {
    const plan = planLift(inputs([port('a', 'item'), list([1, 2, 3])], [port('b', 'item'), list([10])]), { ...opts, lacing: 'longest' });
    expect(plan.lanes.map((l) => l.args.b)).toEqual([10, 10, 10]);
  });

  it('cross lacing keys lanes by "i|j" and refuses products above the guard', () => {
    const plan = planLift(inputs([port('a', 'item'), list(['A', 'B'])], [port('b', 'item'), list([1, 2, 3])]), { ...opts, lacing: 'cross' });
    expect(plan.lanes).toHaveLength(6);
    expect(plan.lanes.map((l) => l.laneKey)).toEqual(['0|0', '0|1', '0|2', '1|0', '1|1', '1|2']);
    expect(() => planLift(inputs([port('a', 'item'), list([1, 2])], [port('b', 'item'), list([1, 2, 3])]), { ...opts, lacing: 'cross', maxCross: 5 })).toThrow(CrossProductTooLarge);
  });

  it('keys lanes by the driving entity GlobalId, and warns when it must fall back to indices', () => {
    const keyed = planLift(inputs([port('e', 'item'), list([ref('W1'), ref('W2')])], [port('v', 'item'), list([1, 2])]), opts);
    expect(keyed.lanes.map((l) => l.laneKey)).toEqual(['W1', 'W2']);
    expect(keyed.warnings).toEqual([]);

    const indexed = planLift(inputs([port('v', 'item'), list([1, 2])]), opts);
    expect(indexed.lanes.map((l) => l.laneKey)).toEqual(['0', '1']);
    expect(indexed.warnings[0]).toMatch(/keyed by index/);
  });

  it('grid × level cross lanes keep their key when a grid line is inserted', () => {
    const grids = ['A', 'B'].map(ref);
    const levels = ['L1', 'L2'].map(ref);
    const before = planLift(inputs([port('g', 'item'), list(grids)], [port('l', 'item'), list(levels)]), { ...opts, lacing: 'cross' });
    const after = planLift(inputs([port('g', 'item'), list([ref('A'), ref('A2'), ref('B')])], [port('l', 'item'), list(levels)]), { ...opts, lacing: 'cross' });
    const beforeKeys = new Set(before.lanes.map((l) => l.laneKey));
    for (const k of beforeKeys) expect(after.lanes.some((l) => l.laneKey === k)).toBe(true);
    expect(after.lanes.filter((l) => !beforeKeys.has(l.laneKey)).map((l) => l.laneKey)).toEqual(['A2|L1', 'A2|L2']);
  });

  it('a null on a non-nullable item port short-circuits the lane', () => {
    const plan = planLift(inputs([port('a', 'item'), list([1, null, 3])]), opts);
    expect(plan.lanes.map((l) => l.nullLane)).toEqual([false, true, false]);
    const nullable = planLift(inputs([port('a', 'item', { nullable: true }), list([1, null])]), opts);
    expect(nullable.lanes.map((l) => l.nullLane)).toEqual([false, false]);
  });
});

describe('planLift — groups match by key', () => {
  const openings = group([
    ['W1', [ref('D1'), ref('D2')]],
    ['W2', [ref('D3')]],
  ]);

  it('an item port over a group runs per (branch, element) with branch|inner keys', () => {
    const plan = planLift(inputs([port('o', 'item'), openings]), opts);
    expect(plan.overGroup).toBe(true);
    expect(plan.lanes.map((l) => [l.branchKey, l.laneKey])).toEqual([
      ['W1', 'W1|D1'],
      ['W1', 'W1|D2'],
      ['W2', 'W2|D3'],
    ]);
  });

  it('a list port over a group runs once per branch with the branch as its list', () => {
    const plan = planLift(inputs([port('os', 'list'), openings]), opts);
    expect(plan.lanes.map((l) => [l.laneKey, (l.args.os as unknown[]).length])).toEqual([
      ['W1', 2],
      ['W2', 1],
    ]);
  });

  it('two groups match branches by key, never by position, and report missing keys', () => {
    const walls = group([
      ['W2', [ref('W2')]],
      ['W1', [ref('W1')]],
      ['W9', [ref('W9')]],
    ]);
    const plan = planLift(inputs([port('wall', 'item'), walls], [port('os', 'list'), openings]), opts);
    // Lane keys always carry branch|inner, even for one-element branches: a
    // wall gaining a second door must not change the first door's key.
    expect(plan.lanes.map((l) => [l.laneKey, (l.args.wall as EntityRef).globalId, (l.args.os as EntityRef[]).map((o) => o.globalId)])).toEqual([
      ['W2|W2', 'W2', ['D3']],
      ['W1|W1', 'W1', ['D1', 'D2']],
    ]);
    expect(plan.missing).toEqual({ os: ['W9'] });
  });

  it('an optional group-carrying port lets the lane run without its branch', () => {
    const walls = group([['W1', [ref('W1')]], ['W9', [ref('W9')]]]);
    const plan = planLift(inputs([port('wall', 'item'), walls], [port('os', 'list', { optional: true }), openings]), opts);
    expect(plan.lanes.map((l) => l.laneKey)).toEqual(['W1|W1', 'W9|W9']);
    expect(plan.lanes[1].args.os).toBeUndefined();
    // W2 exists only in openings: the required `wall` port lacks it, so that lane is skipped and reported.
    expect(plan.missing).toEqual({ os: ['W9'], wall: ['W2'] });
  });

  it('a group port receives the group whole; a list becomes the single branch', () => {
    const asGroup = planLift(inputs([port('g', 'group'), openings]), opts);
    expect(asGroup.lifted).toBe(false);
    expect([...(asGroup.lanes[0].args.g as Map<string, unknown[]>).keys()]).toEqual(['W1', 'W2']);
    const single = planLift(inputs([port('g', 'group'), list([1, 2])]), opts);
    expect([...(single.lanes[0].args.g as Map<string, unknown[]>).entries()]).toEqual([['', [1, 2]]]);
  });
});

describe('assemble', () => {
  it('wraps unlifted outputs by their declared access', () => {
    const plan = planLift(inputs([port('a', 'item'), item(1)]), opts);
    const out = assemble(plan, [port('x', 'item'), port('xs', 'list'), port('g', 'group')], [{ x: 5, xs: [1, 2], g: new Map([['k', [1]]]) }]);
    expect(out.get('x')).toEqual(item(5));
    expect(out.get('xs')).toEqual(list([1, 2]));
    expect(out.get('g')).toEqual(group([['k', [1]]]));
  });

  it('lifted over a list: item outputs become a list, list outputs a group keyed by lane', () => {
    const plan = planLift(inputs([port('e', 'item'), list([ref('W1'), ref('W2')])]), opts);
    const out = assemble(plan, [port('area', 'item'), port('doors', 'list')], [{ area: 10, doors: ['D1', 'D2'] }, { area: 20, doors: [] }]);
    expect(out.get('area')).toEqual(list([10, 20]));
    expect(out.get('doors')).toEqual(group([['W1', ['D1', 'D2']], ['W2', []]]));
  });

  it('lifted over a group: item outputs regroup under their branch; null lanes yield null', () => {
    const data = group([['W1', [1, 2]], ['W2', [3]]]);
    const plan = planLift(inputs([port('v', 'item'), data]), opts);
    const out = assemble(plan, [port('d', 'item')], [{ d: 'a' }, null, { d: 'c' }]);
    expect(out.get('d')).toEqual(group([['W1', ['a', null]], ['W2', ['c']]]));
  });

  it('two lanes sharing a key append, never replace — a repeated driving entity keeps both outputs', () => {
    const plan = planLift(inputs([port('e', 'item'), list([ref('W1'), ref('W1')])]), opts);
    expect(plan.lanes.map((l) => l.laneKey)).toEqual(['W1', 'W1']);
    const out = assemble(plan, [port('n', 'item'), port('xs', 'list')], [{ n: 1, xs: ['a'] }, { n: 2, xs: ['b'] }]);
    expect(out.get('n')).toEqual(list([1, 2]));
    // Before this, `branches.set` made the second lane replace the first —
    // and only for list/group ports, so the loss depended on port access.
    expect(out.get('xs')).toEqual(group([['W1', ['a', 'b']]]));
  });

  it('refuses a list output that is not an array', () => {
    const plan = planLift(inputs([port('a', 'item'), item(1)]), opts);
    expect(() => assemble(plan, [port('xs', 'list')], [{ xs: 'nope' }])).toThrow(/must return an array/);
  });
});
