/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sibling module for `check-server-browser-type-parity.mjs` (#3979), split
 * out purely to stay under the repo's ~400-line module-size budget — see
 * that file's "STALE-ALLOWLIST DETECTION" header section for the full
 * rationale of what this closes and why `deliberate` entries are not
 * exempt. This file holds only the one exported function; everything else
 * about the allowlist (its shape, the `pending`/`deliberate` distinction,
 * `validateAllowlist()`) stays in the main checker.
 */

/**
 * Finds ALLOWLIST entries whose divergence no longer exists. `conceptSets`
 * is `{ [conceptName]: { rust: Set<string>, ts: Set<string> } }` — built by
 * the caller from `checkConcept()`'s own `rust`/`ts` return, so this never
 * re-reads or re-extracts anything, and a concept missing from
 * `conceptSets` (vacuous or under-read this run) is silently skipped rather
 * than judged on data already known to be untrustworthy.
 *
 * An entry's type must be present on EXACTLY ONE side to still describe a
 * real divergence — that is what every note claims ("the server has no arm
 * at all", "TS names it only to skip it"). Present on BOTH sides means the
 * gap was closed (the usual case: a PR named in a `pending` note merged);
 * present on NEITHER means there is nothing here for this gate to ever have
 * flagged (e.g. the type was renamed out from under the entry). Both
 * directions are reported as stale, with a message that tells them apart.
 * Applies to `pending` and `deliberate` entries alike: a `deliberate` entry
 * describes a DECISION, not an exemption from reality, and one whose named
 * divergence has also vanished is just as misleading as a stale `pending`
 * entry citing a merged PR.
 *
 * @returns {{key: string, status: string, reason: string}[]}
 */
export function staleAllowlistEntries(allowlist, conceptSets) {
  const stale = [];
  for (const [key, entry] of Object.entries(allowlist)) {
    const sep = key.indexOf(':');
    if (sep === -1) continue;
    const conceptName = key.slice(0, sep);
    const type = key.slice(sep + 1);
    const sets = conceptSets[conceptName];
    if (!sets) continue;
    const inRust = sets.rust.has(type);
    const inTs = sets.ts.has(type);
    if (inRust === inTs) {
      stale.push({
        key,
        status: entry?.status,
        reason: inRust
          ? 'the type is now handled by BOTH the Rust server and the TS parser — the divergence this entry mutes is gone'
          : 'the type is handled by NEITHER side — there is no divergence here for this entry to mute',
      });
    }
  }
  return stale;
}
