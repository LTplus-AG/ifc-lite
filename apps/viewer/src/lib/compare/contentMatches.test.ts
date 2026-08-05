/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ContentMatch, ContentMatchKind } from '@ifc-lite/diff';
import {
  contentMatchCounts,
  contentMatchingRan,
  isRetiringMatch,
  MATCH_KIND_HINT,
  MATCH_KIND_LABEL,
} from './contentMatches.js';
import type { CompareRef } from './buildFingerprints.js';

const ALL_KINDS: ContentMatchKind[] = [
  'renamed',
  'moved',
  'reshaped',
  'duplicated',
  'deduplicated',
  'ambiguous',
];

function match(kind: ContentMatchKind, base: number, head: number): ContentMatch<CompareRef> {
  const fp = (globalId: number) => ({
    key: `k${globalId}`,
    ifcType: 'IfcWall',
    dataHash: 'd',
    ref: { modelId: 'm', localId: globalId, globalId },
  });
  return {
    kind,
    dataHash: 'd',
    base: Array.from({ length: base }, (_, i) => fp(i + 1)),
    head: Array.from({ length: head }, (_, i) => fp(1000 + i)),
  };
}

describe('isRetiringMatch (#1891)', () => {
  it('is true exactly for the kinds whose entries the engine removed', () => {
    // The retiring/review split drives whether a consumer must supply the
    // elements itself (retiring) or must NOT re-report them (review), so it is
    // pinned per kind rather than inferred.
    assert.deepStrictEqual(
      ALL_KINDS.map(isRetiringMatch),
      [true, true, true, false, false, false],
    );
  });
});

describe('contentMatchingRan (#1891)', () => {
  it('separates "ran and found nothing" from "never ran"', () => {
    // The whole reason this predicate exists rather than a truthiness check at
    // each call site: `[]` means the pass looked and paired nothing, which the
    // panel shows as a Matched badge reading 0. Collapsing it into "no matches"
    // would hide the badge and drop the counts grid back to four columns,
    // making a run that found nothing indistinguishable from one never asked -
    // and it would also flip `useCompare`'s reconciliation gate into re-diffing
    // for ever, because the result would deny the flag it actually ran with.
    assert.strictEqual(contentMatchingRan([]), true);
    assert.strictEqual(contentMatchingRan(undefined), false);
  });

  it('is true for a pass that did pair something', () => {
    assert.strictEqual(contentMatchingRan([match('renamed', 1, 1)]), true);
  });
});

describe('match kind vocabulary (#1891)', () => {
  it('labels and hints every kind the engine can emit', () => {
    for (const kind of ALL_KINDS) {
      assert.ok(MATCH_KIND_LABEL[kind], `missing label for ${kind}`);
      assert.ok(MATCH_KIND_HINT[kind], `missing hint for ${kind}`);
    }
  });
});

describe('contentMatchCounts (#1891)', () => {
  it('tallies zero for a pass that did not run and for one that found nothing', () => {
    for (const input of [undefined, []]) {
      const counts = contentMatchCounts(input);
      assert.strictEqual(counts.total, 0);
      assert.strictEqual(counts.matchedElements, 0);
      assert.strictEqual(counts.needsReviewElements, 0);
    }
  });

  it('counts retired elements on the head side, one per surviving element', () => {
    const counts = contentMatchCounts([match('renamed', 3, 3), match('moved', 1, 1)]);
    assert.strictEqual(counts.renamed, 1);
    assert.strictEqual(counts.moved, 1);
    assert.strictEqual(counts.matchedElements, 4);
    assert.strictEqual(counts.needsReviewElements, 0);
  });

  it('counts a retiring group by its HEAD length, not its base length', () => {
    // Every fixture above happens to use base===head for retiring kinds, which
    // cannot distinguish `match.head.length` from `match.base.length` in the
    // accumulator. A group with base !== head is the only fixture that pins
    // which side the doc comment promises ("counted on the head side").
    const counts = contentMatchCounts([match('renamed', 5, 2)]);
    assert.strictEqual(counts.matchedElements, 2, 'must count the surviving (head) side, not base');
  });

  it('counts an unresolved group on BOTH sides - every candidate needs looking at', () => {
    const counts = contentMatchCounts([match('ambiguous', 2, 3)]);
    assert.strictEqual(counts.ambiguous, 1);
    assert.strictEqual(counts.needsReviewElements, 5);
    assert.strictEqual(counts.matchedElements, 0);
  });

  it('keeps the two families separate in a mixed result', () => {
    const counts = contentMatchCounts([
      match('reshaped', 1, 1),
      match('duplicated', 1, 2),
      match('deduplicated', 2, 1),
    ]);
    assert.strictEqual(counts.total, 3);
    assert.strictEqual(counts.matchedElements, 1);
    assert.strictEqual(counts.needsReviewElements, 6);
  });
});
