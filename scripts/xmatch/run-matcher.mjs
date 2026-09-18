/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What `run.mjs` puts under test: the shipped engine with every stage on, plus
 * the two side tables the guards and the group-move mutation need (the proved
 * volumes per side, the same-content groups). Split out of `run.mjs` for size.
 */

import { diffModels } from '../../packages/diff/dist/index.js';

/** The matcher under test: the shipped engine, at viewer scope, with the two
 *  opt-in claim stages of issue #4955 switched on. */
export function realMatcher(base, head) {
  const diff = diffModels(base, head, {
    scope: 'both',
    matchUnpairedByContent: true,
    detectSplitMerge: true,
    detectSuccessors: true,
  });
  return {
    matches: diff.contentMatches ?? [],
    splitMerges: diff.splitMerges ?? [],
    successors: diff.successors ?? [],
    counts: diff.counts,
  };
}

/** Refs carrying a proved volume, tagged by side: what `verified` needs. */
export function volumeSet(base, head) {
  const set = new Set();
  for (const fingerprint of base.fingerprints) {
    if (fingerprint.volume !== undefined) set.add(`b${fingerprint.ref}`);
  }
  for (const fingerprint of head.fingerprints) {
    if (fingerprint.volume !== undefined) set.add(`h${fingerprint.ref}`);
  }
  return set;
}

/**
 * Meshed elements that share an (`ifcType`, `dataHash`) bucket, largest first.
 *
 * A BASE-side fact only — the mutation program uses it to pick which group to
 * move wholesale, and the answer key still records what it did rather than
 * what any hash later says. Passing the head's hashes in here would be the
 * circularity this fixture is built to avoid.
 */
export function sameContentGroups(base) {
  const groups = new Map();
  for (const fingerprint of base.fingerprints) {
    if (!base.meshedIds.has(fingerprint.ref)) continue;
    const bucket = `${fingerprint.ifcType}\u0000${fingerprint.dataHash}`;
    const list = groups.get(bucket);
    if (list) list.push(fingerprint.ref);
    else groups.set(bucket, [fingerprint.ref]);
  }
  return [...groups.values()].filter((list) => list.length >= 3).sort((a, b) => b.length - a.length);
}
