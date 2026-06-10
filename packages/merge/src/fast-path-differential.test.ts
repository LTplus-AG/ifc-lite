/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Differential fuzz: `planThreeWayMerge` (projection fast path when
 * eligible) must produce exactly the reference plan — full
 * `extractStackState` × 3 fed to `planFromStates` — on every randomly
 * generated scenario. Scenarios deliberately include the cases the fast
 * path must bail on (tombstones, resurrects) and the ones it must get
 * right (creates, attribute nulls, children/inherits edits, multi-opinion
 * same-path nodes, component emptied to a shell).
 */

import { describe, expect, it } from 'vitest';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import { planFromStates, planThreeWayMerge } from './three-way.js';
import { extractStackState } from './component-state.js';
import type { MergePlan } from './types.js';

const CLASS = 'bsi::ifc::class';
const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const ACOUSTIC = 'bsi::ifc::v5a::Pset_Acoustics::SoundRating';

function layer(data: IfcxNode[], id: string): IfcxFile {
  return {
    header: { id, ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 'fuzz', timestamp: 't' },
    imports: [],
    schemas: {},
    data,
  };
}

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Sorted, JSON-normalized view — op emission order is not part of the contract. */
function normalize(plan: MergePlan) {
  return {
    autoOps: plan.autoOps.map((op) => JSON.stringify(op)).sort(),
    conflicts: plan.conflicts.map((c) => JSON.stringify(c)).sort(),
    stats: plan.stats,
  };
}

function referencePlan(ancestor: IfcxFile[], ours: IfcxFile[], theirs: IfcxFile[]): MergePlan {
  return planFromStates(
    extractStackState(ancestor),
    extractStackState(ours),
    extractStackState(theirs)
  );
}

/** One random delta node for `path`; tombstones only when `allowDeletes`. */
function randomNode(rand: () => number, path: string, tag: string, allowDeletes: boolean): IfcxNode {
  const roll = rand();
  if (allowDeletes && roll < 0.1) return { path, attributes: { [IFCLITE_ATTR.DELETED]: true } };
  if (allowDeletes && roll < 0.15) return { path, attributes: { [IFCLITE_ATTR.DELETED]: false } };
  if (roll < 0.3) return { path, attributes: { [FIRE]: null } }; // null removal
  if (roll < 0.45) return { path, attributes: { [ACOUSTIC]: `${tag}-acoustic` } };
  if (roll < 0.6) return { path, children: { Slot: rand() < 0.5 ? `child-of-${path}` : null } };
  if (roll < 0.7) return { path, inherits: { Type: rand() < 0.5 ? 'type-a' : null } };
  if (roll < 0.8) {
    // Brand-new entity created by this side.
    return { path: `${path}-new-${tag}`, attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: tag } };
  }
  return { path, attributes: { [FIRE]: `${tag}-fire` } };
}

function scenario(seed: number, allowDeletes: boolean) {
  const rand = lcg(seed);
  const entityCount = 40;
  const baseNodes: IfcxNode[] = [];
  for (let i = 0; i < entityCount; i++) {
    baseNodes.push({
      path: `e-${i}`,
      attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' },
      ...(i % 5 === 0 ? { children: { Part: `e-${i + 1}` } } : {}),
    });
  }
  // Multi-opinion same-path node: later opinion in the same layer wins.
  baseNodes.push({ path: 'e-1', attributes: { [FIRE]: 'REI90' } });
  const base = layer(baseNodes, 'base');

  const side = (tag: string): IfcxNode[] => {
    const nodes: IfcxNode[] = [];
    for (let i = 0; i < entityCount; i++) {
      if (rand() < 0.35) nodes.push(randomNode(rand, `e-${i}`, tag, allowDeletes));
    }
    return nodes;
  };

  const ancestor = [base];
  const ours = [base, layer(side('ours'), 'ours')];
  const theirs = [base, layer(side('theirs'), 'theirs')];
  return { ancestor, ours, theirs };
}

describe('fast path ≡ reference (differential fuzz)', () => {
  it('tombstone-free scenarios take the projection and match the reference exactly', () => {
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
      const { ancestor, ours, theirs } = scenario(seed, false);
      const fast = planThreeWayMerge({ ancestor, ours, theirs });
      const reference = referencePlan(ancestor, ours, theirs);
      expect(normalize(fast), `seed ${seed}`).toEqual(normalize(reference));
    }
  });

  it('tombstone/resurrect scenarios fall back and still match the reference exactly', () => {
    for (const seed of [4, 9, 16, 25, 36, 49, 64, 81]) {
      const { ancestor, ours, theirs } = scenario(seed, true);
      const fast = planThreeWayMerge({ ancestor, ours, theirs });
      const reference = referencePlan(ancestor, ours, theirs);
      expect(normalize(fast), `seed ${seed}`).toEqual(normalize(reference));
    }
  });

  it('blake3-id prefix equality enables the fast path across separately loaded documents', () => {
    // Same canonical layer loaded twice → different objects, same id.
    const mk = () =>
      layer([{ path: 'w', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } }], 'blake3:abc123');
    const edit = layer([{ path: 'w', attributes: { [FIRE]: 'REI90' } }], 'delta');
    const fast = planThreeWayMerge({ ancestor: [mk()], ours: [mk()], theirs: [mk(), edit] });
    const reference = referencePlan([mk()], [mk()], [mk(), edit]);
    expect(normalize(fast)).toEqual(normalize(reference));
    expect(fast.autoOps).toHaveLength(1);
  });
});
