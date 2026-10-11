/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Train / validation / test splits for the E2 dataset
 * (02-test-and-eval-strategy.md: train allows prompt tuning, validation is the
 * go/no-go set, test is the headline set and is never tuned on).
 *
 * A split is assigned per GROUP, not per case, so that no task leaks across
 * splits. Two cases are in the same group when they come from the same corpus
 * test (the same facet folder and file name once the `pass-`/`fail-` prefix
 * and the `_<n>_<m>` variant suffix are removed), or when they share a
 * description. Either link means the agent would see the same task in two
 * splits. The group's split comes from a SHA-256 hash of its smallest case id,
 * so the assignment is deterministic and does not depend on file order.
 *
 * The split is stored in each record's `split` field. Once committed, the test
 * split is frozen: `e2-dataset.test.mjs` pins a digest of its ids.
 */

import { createHash } from 'node:crypto';

export const E2_SPLITS = ['train', 'validation', 'test'];

/** Percent of groups per split; the bucket is `hash mod 100`. */
const SPLIT_PERCENT = { train: 60, validation: 20, test: 20 };

/** `attribute/pass-foo_bar_2_3` → `attribute/foo_bar`. */
export function corpusTestKey(id) {
  const slash = id.indexOf('/');
  const dir = id.slice(0, slash);
  const base = id.slice(slash + 1).replace(/^(pass|fail)-/, '').replace(/_\d+_\d+$/, '');
  return `${dir}/${base}`;
}

/**
 * Group case ids so that cases from the same corpus test or with the same
 * description share a group (union-find over both links).
 *
 * @param {{ id: string, description: string }[]} cases
 * @returns {Map<string, string>} case id → group key (the group's smallest id)
 */
export function e2SplitGroups(cases) {
  const parent = new Map(cases.map(record => [record.id, record.id]));
  const find = id => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(id, root);
    return root;
  };
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  const firstBy = new Map();
  for (const record of cases) {
    for (const link of [`test:${corpusTestKey(record.id)}`, `description:${record.description}`]) {
      const first = firstBy.get(link);
      if (first === undefined) firstBy.set(link, record.id);
      else union(first, record.id);
    }
  }
  return new Map(cases.map(record => [record.id, find(record.id)]));
}

/** The split for a group key: SHA-256 of the key, first 4 bytes, mod 100. */
export function splitForGroup(groupKey) {
  const bucket = createHash('sha256').update(groupKey).digest().readUInt32BE(0) % 100;
  if (bucket < SPLIT_PERCENT.train) return 'train';
  if (bucket < SPLIT_PERCENT.train + SPLIT_PERCENT.validation) return 'validation';
  return 'test';
}

/**
 * Assign a split to every case.
 *
 * @param {{ id: string, description: string }[]} cases
 * @returns {Map<string, 'train' | 'validation' | 'test'>}
 */
export function assignE2Splits(cases) {
  const groups = e2SplitGroups(cases);
  return new Map(cases.map(record => [record.id, splitForGroup(groups.get(record.id))]));
}

/**
 * Problems with the committed `split` fields: unknown values, and any group
 * whose cases sit in more than one split (a leak).
 *
 * @param {{ id: string, description: string, split?: unknown }[]} cases
 * @returns {string[]}
 */
export function e2SplitErrors(cases) {
  const errors = [];
  const usable = cases.filter(record => record && typeof record.id === 'string' && record.id.includes('/'));
  for (const record of usable) {
    if (!E2_SPLITS.includes(/** @type {string} */ (record.split))) {
      errors.push(`${record.id}: split must be one of ${E2_SPLITS.join('/')}`);
    }
  }
  const groups = e2SplitGroups(usable);
  const splitsByGroup = new Map();
  for (const record of usable) {
    const group = groups.get(record.id);
    const splits = splitsByGroup.get(group) ?? new Set();
    splits.add(record.split);
    splitsByGroup.set(group, splits);
  }
  for (const [group, splits] of splitsByGroup) {
    if (splits.size > 1) errors.push(`group ${group} leaks across splits: ${[...splits].sort().join(', ')}`);
  }
  return errors;
}

/** SHA-256 of the sorted test-split ids, joined by newlines. */
export function testSplitDigest(cases) {
  const ids = cases.filter(record => record.split === 'test').map(record => record.id).sort();
  return createHash('sha256').update(ids.join('\n')).digest('hex');
}
