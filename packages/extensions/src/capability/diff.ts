/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capability set-diff.
 *
 * Given a previous (granted) capability set and a new (requested) set,
 * produce a diff for the re-consent UI. Two capabilities are considered
 * the same iff their `raw` strings are identical *and* their parsed
 * shape is identical (we guard against accidental whitespace / case
 * mismatches).
 *
 * We do NOT consider capability *coverage* here. `model.read` is not
 * considered "the same as" `model.read` with a target — that distinction
 * matters in matching, and matters even more in diff display, because
 * the user must see narrowing as well as broadening.
 *
 * Spec: docs/architecture/ai-customization/02-security.md §3.4.
 */

import type { Capability, CapabilityDiff } from '../types.js';

export function diffCapabilities(
  previous: readonly Capability[],
  next: readonly Capability[],
): CapabilityDiff {
  const previousByKey = new Map<string, Capability>();
  for (const cap of previous) previousByKey.set(keyOf(cap), cap);

  const nextByKey = new Map<string, Capability>();
  for (const cap of next) nextByKey.set(keyOf(cap), cap);

  const added: Capability[] = [];
  const removed: Capability[] = [];
  const unchanged: Capability[] = [];

  for (const [key, cap] of nextByKey) {
    if (previousByKey.has(key)) {
      unchanged.push(cap);
    } else {
      added.push(cap);
    }
  }
  for (const [key, cap] of previousByKey) {
    if (!nextByKey.has(key)) {
      removed.push(cap);
    }
  }

  return { added, removed, unchanged };
}

/**
 * True iff the diff introduces any new capability the user has not
 * previously granted. Used to decide whether re-consent is required.
 */
export function requiresReconsent(diff: CapabilityDiff): boolean {
  return diff.added.length > 0;
}

function keyOf(cap: Capability): string {
  const targetKey = cap.target ? `:${cap.target.raw}` : '';
  return `${cap.scope}.${cap.action}${targetKey}`;
}
