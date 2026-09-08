/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Position-based pairing of the N:M leftovers in a content bucket: iterated
 * mutual nearest neighbour under a distance cap.
 *
 * The property under test is not "pairs as much as possible" but "pairs only
 * where the evidence is unambiguous, and abstains otherwise" — a symmetric
 * layout of identical elements that all moved genuinely *is* ambiguous.
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import { buildComponentFingerprints } from './fingerprint.js';
import type { EntityAabb, EntityFingerprint } from './types.js';

/** A box of `size` centred on `centre`. */
function box(
  centre: [number, number, number],
  size: [number, number, number] = [1, 1, 1],
): EntityAabb {
  return {
    min: [centre[0] - size[0] / 2, centre[1] - size[1] / 2, centre[2] - size[2] / 2],
    max: [centre[0] + size[0] / 2, centre[1] + size[1] / 2, centre[2] + size[2] / 2],
  };
}

/**
 * Same-content door at a position. Every door gets its own geometry hash, so
 * the geometry-hash tier resolves nothing and the whole bucket reaches the
 * position pass.
 */
function door(
  key: string,
  centre: [number, number, number],
  size: [number, number, number] = [1, 1, 1],
): EntityFingerprint<number> {
  return {
    key,
    ifcType: 'IfcDoor',
    dataHash: 'd1',
    geometryHash: `g@${key}`,
    aabb: box(centre, size),
    ref: 0,
  };
}

const kinds = (diff: ReturnType<typeof diffModels>): string[] =>
  (diff.contentMatches ?? []).map((m) => m.kind).sort();

describe('content matching — mutual nearest neighbour (tier 3)', () => {
  it('pairs a group of identical moved elements one-for-one', () => {
    const base = [door('b1', [0, 0, 0]), door('b2', [10, 0, 0])];
    const head = [door('h1', [0.5, 0, 0]), door('h2', [10.5, 0, 0])];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    const matches = diff.contentMatches ?? [];
    expect(matches.map((m) => m.kind)).toEqual(['moved', 'moved']);
    expect(matches.map((m) => [m.base[0].key, m.head[0].key])).toEqual([
      ['b1', 'h1'],
      ['b2', 'h2'],
    ]);
    for (const match of matches) expect(match.distance).toBeCloseTo(0.5, 10);
    // The tier label is the evidence behind the pairing, and this is the only
    // path that reports `positional`: mutual nearest neighbour, not a hash.
    expect(matches.map((m) => m.tier)).toEqual(['positional', 'positional']);
  });

  it('abstains on a symmetric layout where nothing has a unique nearest neighbour', () => {
    // Every base is exactly equidistant from both heads. A total-distance
    // optimiser would happily pair these; there is no evidence for either
    // assignment, so the honest answer is "ambiguous".
    const base = [door('b1', [-1, 0, 0]), door('b2', [1, 0, 0])];
    const head = [door('h1', [0, -1, 0]), door('h2', [0, 1, 0])];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 0 });
    expect(kinds(diff)).toEqual(['ambiguous']);
    expect(diff.contentMatches?.[0]?.base.map((e) => e.key)).toEqual(['b1', 'b2']);
  });

  it('iterates to a fixpoint: retiring a confident pair unlocks a tied one', () => {
    // h2 sits exactly between b1 and b2, so it has no unique nearest base in
    // the first round. Once (b1, h1) retires, b2 is the only base left and h2
    // becomes unambiguous.
    const base = [door('b1', [0, 0, 0]), door('b2', [10, 0, 0])];
    const head = [door('h1', [0.1, 0, 0]), door('h2', [5, 0, 0])];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    const matches = diff.contentMatches ?? [];
    expect(matches.map((m) => [m.base[0].key, m.head[0].key])).toEqual([
      ['b1', 'h1'],
      ['b2', 'h2'],
    ]);
    expect(matches[1]?.distance).toBeCloseTo(5, 10);
  });

  it('classifies a positionally paired element that also changed size as reshaped', () => {
    const base = [door('b1', [0, 0, 0]), door('b2', [10, 0, 0])];
    const head = [door('h1', [0.5, 0, 0], [2, 1, 1]), door('h2', [10.5, 0, 0])];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    const matches = diff.contentMatches ?? [];
    expect(matches.map((m) => [m.base[0].key, m.kind])).toEqual([
      ['b1', 'reshaped'],
      ['b2', 'moved'],
    ]);
  });

  it('refuses a pair beyond maxMoveDistance and leaves it ambiguous', () => {
    const base = [door('b1', [0, 0, 0]), door('b2', [100, 0, 0])];
    const head = [door('h1', [1, 0, 0]), door('h2', [1000, 0, 0])];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    // Only the near pair retires; the teleport stays an unresolved candidate.
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(kinds(diff)).toEqual(['ambiguous', 'moved']);
    const leftover = diff.contentMatches?.find((m) => m.kind === 'ambiguous');
    expect(leftover?.base.map((e) => e.key)).toEqual(['b2']);
    expect(leftover?.head.map((e) => e.key)).toEqual(['h2']);
  });

  it('honours a caller-supplied maxMoveDistance', () => {
    const base = [door('b1', [0, 0, 0]), door('b2', [100, 0, 0])];
    const head = [door('h1', [1, 0, 0]), door('h2', [1000, 0, 0])];

    const diff = diffModels(base, head, {
      matchUnpairedByContent: true,
      maxMoveDistance: 1000,
    });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    expect(kinds(diff)).toEqual(['moved', 'moved']);
  });

  it('does not pair positionally when a candidate has no bounding box', () => {
    const base = [door('b1', [0, 0, 0]), door('b2', [10, 0, 0])];
    const withoutBox: EntityFingerprint<number> = {
      key: 'h1',
      ifcType: 'IfcDoor',
      dataHash: 'd1',
      geometryHash: 'g@h1',
      ref: 0,
    };
    const head = [withoutBox, door('h2', [10.5, 0, 0])];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 0 });
    expect(kinds(diff)).toEqual(['ambiguous']);
  });

  const componentsFor = (reference: string) =>
    buildComponentFingerprints({
      ifcType: 'IfcDoor',
      name: 'Door',
      propertySets: [
        { name: 'Pset_DoorCommon', properties: [{ name: 'Reference', value: reference }] },
      ],
    });
  const withComponents = (
    entity: EntityFingerprint<number>,
    reference: string,
  ): EntityFingerprint<number> => ({ ...entity, components: componentsFor(reference) });

  it('keeps the componentsAgree guard on the positional path', () => {
    const base = [
      withComponents(door('b1', [0, 0, 0]), 'A'),
      withComponents(door('b2', [10, 0, 0]), 'A'),
    ];
    const head = [
      withComponents(door('h1', [0.5, 0, 0]), 'B'),
      withComponents(door('h2', [10.5, 0, 0]), 'B'),
    ];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    // Position says these are the same doors; the component sub-hashes prove
    // the shared data hash was a collision, and the guard wins.
    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 0 });
    expect(kinds(diff)).toEqual(['ambiguous']);
  });

  it('leaves a guard-rejected pair in the pool instead of retiring a later round on it', () => {
    // b1/h1 are each other's unique nearest, so the first round proposes them
    // and the component sub-hashes reject the pair. b2's nearest head is h1
    // (2.5) and not h2 (3), so (b2, h2) is NOT mutual nearest while b1 and h1
    // are in the pool — it only becomes mutual once they are gone. Rejecting
    // (b1, h1) *after* the fixpoint had already retired them therefore paired
    // b2 with h2 on a pool that never existed, destroying a real added/deleted
    // pair. The rejection has to be part of the pairing predicate.
    const base = [
      withComponents(door('b1', [0, 0, 0]), 'A'),
      withComponents(door('b2', [3, 0, 0]), 'C'),
    ];
    const head = [
      withComponents(door('h1', [0.5, 0, 0]), 'B'),
      withComponents(door('h2', [6, 0, 0]), 'C'),
    ];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 0 });
    expect(kinds(diff)).toEqual(['ambiguous']);
    const group = diff.contentMatches?.[0];
    expect(group?.base.map((e) => e.key)).toEqual(['b1', 'b2']);
    expect(group?.head.map((e) => e.key)).toEqual(['h1', 'h2']);
  });

  it('rejects the pair, not the round: an unrelated pair in the same round still retires', () => {
    // The veto is local. (b2, h2) is mutual nearest with b1 and h1 present, so
    // its basis is unaffected by their rejection and it retires as usual.
    const base = [
      withComponents(door('b1', [0, 0, 0]), 'A'),
      withComponents(door('b2', [50, 0, 0]), 'C'),
    ];
    const head = [
      withComponents(door('h1', [0.5, 0, 0]), 'B'),
      withComponents(door('h2', [50.5, 0, 0]), 'C'),
    ];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(kinds(diff)).toEqual(['ambiguous', 'moved']);
    const moved = diff.contentMatches?.find((m) => m.kind === 'moved');
    expect([moved?.base[0]?.key, moved?.head[0]?.key]).toEqual(['b2', 'h2']);
    const group = diff.contentMatches?.find((m) => m.kind === 'ambiguous');
    expect([group?.base[0]?.key, group?.head[0]?.key]).toEqual(['b1', 'h1']);
  });
});

describe('content matching — position pairing bails out on very large groups', () => {
  /** `count` doors per side, each head 0.5 to the right of its base. */
  function group(count: number): {
    base: EntityFingerprint<number>[];
    head: EntityFingerprint<number>[];
  } {
    const base: EntityFingerprint<number>[] = [];
    const head: EntityFingerprint<number>[] = [];
    for (let i = 0; i < count; i++) {
      base.push(door(`b${i}`, [i * 5, 0, 0]));
      head.push(door(`h${i}`, [i * 5 + 0.5, 0, 0]));
    }
    return { base, head };
  }

  it('pairs a group at the size limit', () => {
    const { base, head } = group(128);

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    expect(diff.contentMatches).toHaveLength(128);
    expect(new Set(kinds(diff))).toEqual(new Set(['moved']));
  });

  it('reports a group above the size limit as ambiguous instead', () => {
    const { base, head } = group(129);

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 129, modified: 0, deleted: 129, unchanged: 0 });
    expect(kinds(diff)).toEqual(['ambiguous']);
    expect(diff.contentMatches?.[0]?.base).toHaveLength(129);
  });
});
