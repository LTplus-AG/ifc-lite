/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stored exclusion rules FAIL CLOSED on a malformed `enabled` flag (#2535).
 *
 * An exclusion rule's whole job is to HIDE clashes, so this validator's
 * failure direction is inverted relative to most input validation: a
 * corrupted or partially-written localStorage entry that loads as enabled
 * silently hides real coordination problems from a coordinator, with no
 * signal anywhere. The contract under guard: `loadExclusions` maps ONLY the
 * literal `enabled: true` (what `saveExclusions` writes for an enabled rule)
 * to an enabled rule; a missing or non-boolean value loads the rule DISABLED,
 * so it stays visible in the panel but suppresses nothing.
 *
 * This is deliberately a mutation-sensitive suite: `enabled: r.enabled !==
 * false` (the fail-open form this replaced) must turn it red. The end-to-end
 * store path is additionally covered in `clashSlice.exclusions.test.ts`
 * ("a stored exclusion with a missing or non-boolean `enabled` ...").
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Clash, ClashElementRef, ClashResult } from '@ifc-lite/clash';
import { loadExclusions } from './persistence.js';
import { applyClashExclusions } from './exclusions.js';

const EXCLUSIONS_KEY = 'ifc-lite-clash-exclusions';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  get length(): number { return this.store.size; }
  key(i: number): string | null { return [...this.store.keys()][i] ?? null; }
}

const g = globalThis as { localStorage?: unknown };

function ref(key: string, tag: string): ClashElementRef {
  return { model: 'm', key, tag, ref: 0 };
}

let seq = 0;
function clashOf(a: ClashElementRef, b: ClashElementRef): Clash {
  seq += 1;
  return {
    id: `c${seq}`,
    a,
    b,
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.05,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'major',
  };
}

/** One clash per stored rule below, so each rule's effect is separable. */
function resultOfFivePairs(): ClashResult {
  const clashes = [
    clashOf(ref('R1', 'IfcRail'), ref('C1', 'IfcCourse')),
    clashOf(ref('B1', 'IfcBeam'), ref('B2', 'IfcBeam')),
    clashOf(ref('D1', 'IfcDoor'), ref('W1', 'IfcWindow')),
    clashOf(ref('P1', 'IfcPipeSegment'), ref('U1', 'IfcDuctSegment')),
    clashOf(ref('S1', 'IfcSlab'), ref('K1', 'IfcColumn')),
  ];
  return {
    clashes,
    summary: {
      total: 5,
      byRule: { 'all-clashes': 5 },
      byTypePair: {},
      bySeverity: { critical: 0, major: 5, minor: 0, info: 0 },
    },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

describe('loadExclusions - the enabled flag fails closed (#2535)', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    g.localStorage = storage;
    storage.setItem(
      EXCLUSIONS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        exclusions: [
          // Partially-written entry: `enabled` absent entirely.
          { id: 'absent', kind: 'typePair', a: 'IfcRail', b: 'IfcCourse', label: 'l', createdAt: 1 },
          // Truthy non-boolean garbage of both common shapes.
          { id: 'one', kind: 'typeAny', a: 'IfcBeam', b: 'IfcBeam', label: 'l', enabled: 1, createdAt: 2 },
          { id: 'yes', kind: 'typePair', a: 'IfcDoor', b: 'IfcWindow', label: 'l', enabled: 'yes', createdAt: 3 },
          // The two values saveExclusions actually writes.
          { id: 'on', kind: 'typePair', a: 'IfcPipeSegment', b: 'IfcDuctSegment', label: 'l', enabled: true, createdAt: 4 },
          { id: 'off', kind: 'typePair', a: 'IfcSlab', b: 'IfcColumn', label: 'l', enabled: false, createdAt: 5 },
        ],
      }),
    );
  });

  it('maps only the literal `enabled: true` to an enabled rule', () => {
    const loaded = loadExclusions();
    assert.deepStrictEqual(
      loaded.map((r) => [r.id, r.enabled]),
      [
        ['absent', false],
        ['one', false],
        ['yes', false],
        ['on', true],
        ['off', false],
      ],
      'a missing or non-boolean enabled flag must load DISABLED; only a literal true may suppress',
    );
  });

  it('rules loaded from malformed flags suppress nothing; the valid enabled rule still does', () => {
    const loaded = loadExclusions();
    const outcome = applyClashExclusions(resultOfFivePairs(), loaded);
    assert.strictEqual(
      outcome.suppressed,
      1,
      'exactly the one rule stored with a literal enabled: true may hide its clash',
    );
    const keptPairs = outcome.result?.clashes.map((c) => `${c.a.tag}|${c.b.tag}`) ?? [];
    assert.deepStrictEqual(keptPairs, [
      'IfcRail|IfcCourse',
      'IfcBeam|IfcBeam',
      'IfcDoor|IfcWindow',
      'IfcSlab|IfcColumn',
    ]);
    // The defused rules still report their reach, so the panel can show what
    // re-enabling each one would hide.
    assert.strictEqual(outcome.counts.get('absent'), 1);
    assert.strictEqual(outcome.counts.get('one'), 1);
  });
});
