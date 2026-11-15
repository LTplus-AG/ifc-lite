// SPDX-License-Identifier: MPL-2.0
import { expect, it } from 'vitest';
import { StoreyPlannerIndex, type PlannerProduct } from './storey-planner-index.js';
it('#8452 bounded inventory planning agrees with a full classification oracle through edits and inverse batches', () => {
  const index = new StoreyPlannerIndex();
  const rows = new Map<number, PlannerProduct>();
  for (let id = 1; id <= 10000; id++) rows.set(id, { id, storey: id % 10, placement: id + 20000, parentPlacement: null, attachmentTargets: id % 1000 === 0 ? [99] : [], exceptional: id % 1001 === 0 });
  index.apply(0, 1, rows);
  const check = () => {
    const expected = [...rows.values()].filter(p => (p.storey === 3 && p.exceptional) || p.attachmentTargets.includes(99)).map(p => p.id);
    expect([...index.candidates([3, 99], [])].sort((a,b) => a-b)).toEqual(expected.sort((a,b) => a-b));
    expect([...index.moved([3])].sort((a,b) => a-b)).toEqual([...rows.values()].filter(p => p.storey === 3).map(p => p.id));
    expect(expected.length).toBeLessThan(30);
  };
  check();
  const old = rows.get(1000)!; const edited = { ...old, storey: 3, attachmentTargets: [], exceptional: true };
  index.apply(1, 2, [[1000, edited]]); rows.set(1000, edited); check();
  expect(() => index.apply(1, 3, [[1000, null]])).toThrow(/continuity/); check();
  index.apply(2, 3, [[1000, old]]); rows.set(1000, old); check();
  index.apply(3, 4, [[1000, null]]); rows.delete(1000); check();
});
it('#8452 placement closure bounds cycles and retains foreign owners and unresolved records', () => {
  const index = new StoreyPlannerIndex();
  const product = (id: number, placement: number | null, parentPlacement: number | null): PlannerProduct => ({ id, storey: 9, placement, parentPlacement, attachmentTargets: [], exceptional: false });
  index.apply(0, 1, [[1, product(1, 10, 20)], [2, product(2, 20, 10)], [3, product(3, 10, null)], [4, product(4, null, null)]]);
  expect([...index.candidates([], [10])].sort()).toEqual([1,2,3,4]);
  expect(() => index.apply(1, 2, [[1, null], [2, product(99, 20, null)]])).toThrow(/mismatch/);
  expect([...index.candidates([], [10])].sort()).toEqual([1,2,3,4]);
});

it('#8452 floor-height inventory skips equal-delta attachment groups without rereading product payloads', () => {
  const index = new StoreyPlannerIndex();
  let reads = 0;
  const rows = Array.from({ length: 10000 }, (_, i) => {
    const home = i % 10;
    const p: PlannerProduct = { id: i + 1, storey: home, placement: i + 20000, parentPlacement: null,
      get attachmentTargets() { reads++; return [home + 1]; }, exceptional: false };
    return [p.id, p] as const;
  });
  index.apply(0, 1, rows); reads = 0;
  const deltas = new Map(Array.from({ length: 9 }, (_, i) => [i + 1, .25] as const));
  const expected = rows.filter(([, p]) => (deltas.get(p.storey + 1) ?? 0) !== (deltas.get(p.storey) ?? 0)).map(([id]) => id);
  expect([...index.heightCandidates(deltas)].sort((a,b) => a-b)).toEqual(expected);
  expect(expected).toHaveLength(2000); // Home 0 grows; home 9 targets the unshifted floor 10.
  expect(reads).toBe(0);
});
