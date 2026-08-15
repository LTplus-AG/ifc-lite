/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the identity-map PRODUCER (issue #1891):
 * `identityMapFromContentMatches`.
 *
 * The producer's whole job is restraint. Anything it emits becomes a durable,
 * replayable claim that "these two keys are one element", so the tests are
 * mostly about what it refuses to emit: reporting-only match kinds, and the N:N
 * `renamed` group where every bijection is observationally identical and
 * picking one would be a coin flip written down as fact.
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import {
  CONTENT_MATCH_REASON_PREFIX,
  identityMapFromContentMatches,
} from './identity-map.js';
import type { ContentMatch, EntityFingerprint } from './types.js';

function fp(
  key: string,
  opts: Partial<Omit<EntityFingerprint<number>, 'key'>> = {},
): EntityFingerprint<number> {
  return {
    key,
    ifcType: opts.ifcType ?? 'IfcWall',
    dataHash: opts.dataHash ?? 'd0',
    geometryHash: opts.geometryHash,
    aabb: opts.aabb,
    ref: opts.ref ?? 0,
  };
}

function match(
  kind: ContentMatch<number>['kind'],
  base: string[],
  head: string[],
): ContentMatch<number> {
  return {
    kind,
    dataHash: 'd1',
    base: base.map((key) => fp(key)),
    head: head.map((key) => fp(key)),
  };
}

describe('identityMapFromContentMatches — what it claims', () => {
  it('mints one entry per 1:1 destructive match, base→here in the manifest vocabulary', () => {
    const entries = identityMapFromContentMatches([
      match('renamed', ['old-a'], ['new-a']),
      match('moved', ['old-b'], ['new-b']),
      match('reshaped', ['old-c'], ['new-c']),
    ]);

    expect(entries).toEqual([
      { base: 'old-a', here: 'new-a', reason: 'content-match:renamed' },
      { base: 'old-b', here: 'new-b', reason: 'content-match:moved' },
      { base: 'old-c', here: 'new-c', reason: 'content-match:reshaped' },
    ]);
  });

  it('records the evidence in the reason rather than a bare "derived"', () => {
    const [entry] = identityMapFromContentMatches([match('moved', ['o'], ['n'])]);
    expect(entry.reason.startsWith(CONTENT_MATCH_REASON_PREFIX)).toBe(true);
    // `"derived"` is reserved by 04-identity.md §4.1(3) for the content-derived
    // identity FALLBACK, which is a different claim from a content match.
    expect(entry.reason).not.toBe('derived');
    expect(entry.reason).toContain('moved');
  });

  it('tolerates a diff that never ran the content pass', () => {
    expect(identityMapFromContentMatches(undefined)).toEqual([]);
  });
});

describe('identityMapFromContentMatches — what it refuses', () => {
  it('emits nothing for ambiguous / duplicated / deduplicated', () => {
    const entries = identityMapFromContentMatches([
      match('ambiguous', ['b1', 'b2'], ['h1', 'h2']),
      match('duplicated', ['b1'], ['h1', 'h2']),
      match('deduplicated', ['b1', 'b2'], ['h1']),
    ]);
    expect(entries).toEqual([]);
  });

  it('emits nothing for a ONE-TO-ONE ambiguous match', () => {
    // The load-bearing case, and the one the 1:1 arity guard does not cover:
    // `groupKind(1, 1)` is `ambiguous`, which is reachable whenever the
    // position pass resolves part of an N:M group and leaves one candidate on
    // each side. Those two are not a pair — they are what is left after the
    // engine refused to pair them — so the arity alone must never be mistaken
    // for evidence.
    expect(identityMapFromContentMatches([match('ambiguous', ['b1'], ['h1'])])).toEqual([]);
  });

  it('emits nothing for a one-to-one duplicated or deduplicated match', () => {
    // Not reachable from the engine today (`groupKind` only returns these for
    // a lopsided group), but the exclusion is a property of the KIND, not of
    // the arity, and must not silently start depending on the arity.
    expect(identityMapFromContentMatches([match('duplicated', ['b1'], ['h1'])])).toEqual([]);
    expect(identityMapFromContentMatches([match('deduplicated', ['b1'], ['h1'])])).toEqual([]);
  });

  it('emits nothing for an N:N renamed group — no bijection is defensible', () => {
    // Both sides agreed on the data hash AND the world geometry hash twice
    // over, which is exactly why the engine reports the group as a set. Any
    // pairing here is a guess that only starts to matter once the members
    // diverge in a later revision — by which time nothing records that it was
    // a guess.
    const entries = identityMapFromContentMatches([
      match('renamed', ['old-1', 'old-2'], ['new-1', 'new-2']),
    ]);
    expect(entries).toEqual([]);
  });

  it('emits nothing when a claimable kind is lopsided', () => {
    expect(identityMapFromContentMatches([match('renamed', ['b1'], ['h1', 'h2'])])).toEqual([]);
    expect(identityMapFromContentMatches([match('reshaped', ['b1', 'b2'], ['h1'])])).toEqual([]);
  });

  it('drops a self-claim: an alias onto its own key is a no-op', () => {
    expect(identityMapFromContentMatches([match('renamed', ['same'], ['same'])])).toEqual([]);
  });
});

describe('identityMapFromContentMatches — end to end from a real diff', () => {
  it('turns a re-GUIDed pair into a replayable claim, and an ambiguous group into none', () => {
    // Two re-GUIDed walls that are individually unambiguous (distinct geometry
    // hashes), plus two data-and-geometry-identical doors that are not.
    const base = [
      fp('old-wall-a', { dataHash: 'w1', geometryHash: 10n }),
      fp('old-wall-b', { dataHash: 'w2', geometryHash: 20n }),
      fp('old-door-1', { ifcType: 'IfcDoor', dataHash: 'dd', geometryHash: 30n }),
      fp('old-door-2', { ifcType: 'IfcDoor', dataHash: 'dd', geometryHash: 31n }),
    ];
    const head = [
      fp('new-wall-a', { dataHash: 'w1', geometryHash: 10n }),
      fp('new-wall-b', { dataHash: 'w2', geometryHash: 20n }),
      fp('new-door-1', { ifcType: 'IfcDoor', dataHash: 'dd', geometryHash: 32n }),
      fp('new-door-2', { ifcType: 'IfcDoor', dataHash: 'dd', geometryHash: 33n }),
    ];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });
    const entries = identityMapFromContentMatches(diff.contentMatches);

    // Only the two unambiguous walls become claims; the four doors are an
    // ambiguous group (no shared geometry hash, no aabb to position them) and
    // stay a question for a human.
    expect(entries).toEqual([
      { base: 'old-wall-a', here: 'new-wall-a', reason: 'content-match:renamed' },
      { base: 'old-wall-b', here: 'new-wall-b', reason: 'content-match:renamed' },
    ]);
    expect(diff.contentMatches?.some((m) => m.kind === 'ambiguous')).toBe(true);
  });
});
