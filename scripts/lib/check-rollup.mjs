// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * GitHub retains check runs from a cancelled, superseded workflow alongside
 * the replacement run on the same commit. Required-check evaluation uses the
 * newest run for a context; counting every historical row instead makes a
 * green replacement look failed (#3792).
 *
 * Deduplication requires both a stable context name and parseable timestamps.
 * Unknown rows stay visible and ties stay together, preserving the sweep's
 * fail-closed direction instead of guessing which ambiguous row superseded
 * which.
 */
export function currentRollupChecks(rollup) {
  const unnamed = [];
  const groups = new Map();
  for (const check of rollup ?? []) {
    const name = check?.__typename === 'StatusContext' ? check?.context : check?.name;
    if (typeof name !== 'string' || name === '') {
      unnamed.push(check);
      continue;
    }
    const group = groups.get(name) ?? [];
    group.push(check);
    groups.set(name, group);
  }

  const current = [...unnamed];
  for (const group of groups.values()) {
    if (group.length === 1) {
      current.push(group[0]);
      continue;
    }
    const times = group.map((check) => Date.parse(check?.startedAt ?? ''));
    if (times.some((time) => !Number.isFinite(time))) {
      current.push(...group);
      continue;
    }
    const newest = Math.max(...times);
    current.push(...group.filter((_check, index) => times[index] === newest));
  }
  return current;
}

/** Count the current rollup into pass/fail/pending. */
export function countCurrentRollup(rollup) {
  let fail = 0;
  let pending = 0;
  let pass = 0;
  for (const check of currentRollupChecks(rollup)) {
    const status = String(check?.status ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') {
      pending += 1;
      continue;
    }
    const verdict = String(check?.conclusion ?? check?.state ?? '').toUpperCase();
    if (verdict === 'SUCCESS' || verdict === 'NEUTRAL' || verdict === 'SKIPPED') pass += 1;
    else if (verdict === '' || verdict === 'PENDING' || verdict === 'EXPECTED') pending += 1;
    else fail += 1;
  }
  return { fail, pending, pass };
}
