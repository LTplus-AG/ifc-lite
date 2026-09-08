/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two MUTANT matchers the harness is checked against.
 *
 * A validation fixture that cannot reject an obviously wrong matcher proves
 * nothing about the right one, so `run.mjs --self-test` runs both of these
 * through the exact same scoring path and asserts the thresholds reject each.
 * They fail in opposite directions on purpose: one claims everything, the
 * other claims nothing, and a fixture blind to either is broken in a way that
 * would otherwise be invisible.
 */

/**
 * MUTANT 1 — pairs everything it is handed, in a fixed order, claiming the
 * strongest tier. A fixture that cannot fail this is measuring nothing: it
 * scores maximal recall while pairing deleted elements with inserted ones.
 */
export function alwaysMatchMatcher(base, head) {
  const order = (list) =>
    [...list].sort((a, b) => a.ifcType.localeCompare(b.ifcType) || a.dataHash.localeCompare(b.dataHash));
  const bases = order(base);
  const heads = order(head);
  const matches = [];
  for (let i = 0; i < Math.min(bases.length, heads.length); i++) {
    matches.push({
      kind: 'renamed',
      tier: 'geometry-hash',
      dataHash: bases[i].dataHash,
      base: [bases[i]],
      head: [heads[i]],
    });
  }
  return { matches, counts: null };
}

/** MUTANT 2 — never claims anything. Perfect precision, zero recall; a fixture
 *  that passes this is scoring only the pairs the matcher chose to produce. */
export function alwaysAbstainMatcher() {
  return { matches: [], counts: null };
}


/**
 * MUTANT 3 — the real matcher, then greedily pairs everything it left over.
 *
 * This is the specific regression the other two mutants do NOT model: a
 * matcher that buys RECALL by lowering its bar. Measured, not assumed — it
 * beats the real engine's recall on every model in the corpus:
 *
 *   duplex  0.920128 -> 0.926518   at precision 0.903427
 *   AC20    0.825397 -> 0.841270   at precision 0.791045
 *   rvt01   0.939693 -> 0.950658   at precision 0.942391
 *
 * So it clears every recall floor, and the fixture must still reject it. It
 * does, twice over: on the precision floors, and on `falsePairs.wrongPartner`,
 * whose ceiling is ZERO. That second one is the real defence — every wrong
 * pair increments exactly one negative-control counter, so precision below 1
 * is a hard failure before any precision floor is consulted, and the cheapest
 * way to game a recall floor is also the loudest way to fail.
 */
export function overEagerMatcher(base, head, realMatches) {
  // Only RETIRING matches count as claimed. A `duplicated` / `ambiguous`
  // record is the engine declining to guess, and its members are precisely
  // what this mutant exists to guess about — treating them as claimed left it
  // with nothing to be over-eager with, which is how the first version of this
  // mutant came out identical to the real matcher.
  const retiring = new Set(['renamed', 'moved', 'reshaped']);
  const claimedBase = new Set();
  const claimedHead = new Set();
  for (const match of realMatches) {
    if (!retiring.has(match.kind)) continue;
    for (const entity of match.base) claimedBase.add(entity.ref);
    for (const entity of match.head) claimedHead.add(entity.ref);
  }
  const realMatchesRetiring = realMatches.filter((match) => retiring.has(match.kind));
  // Bucket the leftovers exactly as the engine does, then pair them off in
  // order INSIDE each bucket — no geometry sub-bucketing, no unique-nearest
  // requirement, no component-agreement veto. This is the engine with its
  // abstentions removed: every candidate it declined to guess about, guessed.
  const bucket = (entity) => `${entity.ifcType}\u0000${entity.dataHash}`;
  const buckets = new Map();
  for (const entity of base) {
    if (claimedBase.has(entity.ref)) continue;
    const key = bucket(entity);
    if (!buckets.has(key)) buckets.set(key, { base: [], head: [] });
    buckets.get(key).base.push(entity);
  }
  for (const entity of head) {
    if (claimedHead.has(entity.ref)) continue;
    const key = bucket(entity);
    if (!buckets.has(key)) buckets.set(key, { base: [], head: [] });
    buckets.get(key).head.push(entity);
  }

  const matches = [...realMatchesRetiring];
  for (const group of buckets.values()) {
    group.base.sort((a, b) => a.ref - b.ref);
    group.head.sort((a, b) => a.ref - b.ref);
    for (let i = 0; i < Math.min(group.base.length, group.head.length); i++) {
      matches.push({
        kind: 'renamed',
        tier: 'residue-1-1',
        dataHash: group.base[i].dataHash,
        base: [group.base[i]],
        head: [group.head[i]],
      });
    }
  }
  return { matches, counts: null };
}
