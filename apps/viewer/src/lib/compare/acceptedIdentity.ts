/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The in-session identity a user builds by reviewing the Compare panel's
 * suggestions (issue #4955): the pairs they ACCEPTED (an identity-map entry
 * each, replayed as `keyAliases` on the next diff) and the pairs they refused
 * (so the same suggestion is never offered twice).
 *
 * Every decision is scoped to the (base model, head model) pair it was made
 * for. A GlobalId is only meaningful inside its file, so an alias accepted
 * for A vs B must not be replayed onto A vs C; the store keeps decisions for
 * every pair of the session and each consumer reads its own pair's.
 *
 * Pure reducers over plain values, kept out of the store slice so the rules
 * can be unit-tested without a store and so the slice stays "deliberately
 * dumb" (its own top-of-file comment). The engine never mints these entries
 * unattended (`04-identity.md` §4.5); every entry here came from a click or
 * from an imported sidecar.
 */

import type { IdentityMapEntry } from '@ifc-lite/diff';

/** The two federation model ids a decision was made for. */
export interface ComparePair {
  baseModelId: string;
  headModelId: string;
  /**
   * The authored key scheme the decision's `base`/`here` are keys under
   * (issue #4989) — `undefined` means GlobalId. Two pairs with the same
   * model ids but a different scheme are NOT the same pair: a GlobalId
   * accepted under GlobalId must not replay once the panel is keyed on
   * `Pset_Asset.AssetId`, where the same string means something else (or
   * nothing at all).
   */
  keyProperty?: string;
}

/** One accepted pair, with the models it was accepted for. */
export interface AcceptedIdentity extends IdentityMapEntry, ComparePair {}

/** One refused suggestion, with the models it was refused for. */
export interface RejectedClaim extends ComparePair {
  base: string;
  here: string;
}

/**
 * Signature of one (base, here) pair. NUL separator, as everywhere in the
 * diff package: an entity key never contains one, so no two pairs can alias.
 */
export function claimSignature(base: string, here: string): string {
  return `${base}\u0000${here}`;
}

function samePair(a: ComparePair, b: ComparePair): boolean {
  return (
    a.baseModelId === b.baseModelId
    && a.headModelId === b.headModelId
    && a.keyProperty === b.keyProperty
  );
}

/** The plain identity-map entries accepted for one model pair, in
 *  acceptance order. What the sidecar exports and the diff replays. */
export function acceptedForPair(
  entries: readonly AcceptedIdentity[],
  pair: ComparePair,
): IdentityMapEntry[] {
  return entries
    .filter((entry) => samePair(entry, pair))
    .map(({ base, here, reason }) => ({ base, here, reason }));
}

/** Signatures of the suggestions refused for one model pair. */
export function rejectedForPair(
  rejected: readonly RejectedClaim[],
  pair: ComparePair,
): ReadonlySet<string> {
  return new Set(rejected.filter((r) => samePair(r, pair)).map((r) => claimSignature(r.base, r.here)));
}

/**
 * Add entries to the accepted list for one model pair.
 *
 * - A pair already present is not added twice.
 * - A `here` already claimed for a DIFFERENT `base` is refused, and so is a
 *   `base` already claimed for a different `here`: identity is 1:1, and the
 *   engine ignores an alias that collides anyway (`DiffOptions.keyAliases`),
 *   so accepting it would record a claim that never takes effect. The refused
 *   entries are returned so the caller can say so.
 * - A self-claim (`base === here`) is a no-op the engine would filter; dropped.
 *
 * Returns the SAME array when nothing was added, so a store `set` with the
 * result is a no-op for subscribers.
 */
export function addAcceptedIdentity(
  current: readonly AcceptedIdentity[],
  pair: ComparePair,
  additions: Iterable<IdentityMapEntry>,
): { entries: AcceptedIdentity[]; refused: IdentityMapEntry[] } {
  const bases = new Map<string, string>();
  const heres = new Map<string, string>();
  for (const entry of current) {
    if (!samePair(entry, pair)) continue;
    bases.set(entry.base, entry.here);
    heres.set(entry.here, entry.base);
  }
  const entries = [...current];
  const refused: IdentityMapEntry[] = [];
  let added = false;
  for (const entry of additions) {
    if (entry.base === entry.here) continue;
    const knownHere = bases.get(entry.base);
    const knownBase = heres.get(entry.here);
    if (knownHere === entry.here && knownBase === entry.base) continue; // duplicate
    if (knownHere !== undefined || knownBase !== undefined) {
      refused.push(entry);
      continue;
    }
    bases.set(entry.base, entry.here);
    heres.set(entry.here, entry.base);
    entries.push({
      baseModelId: pair.baseModelId,
      headModelId: pair.headModelId,
      // Omitted rather than set to `undefined` for the GlobalId scheme, so a
      // pre-#4989 entry and a GlobalId-scheme entry are structurally
      // identical (no stray `keyProperty: undefined` key to trip a
      // deep-equal check or a serialized snapshot).
      ...(pair.keyProperty !== undefined ? { keyProperty: pair.keyProperty } : {}),
      base: entry.base,
      here: entry.here,
      reason: entry.reason,
    });
    added = true;
  }
  return { entries: added ? entries : (current as AcceptedIdentity[]), refused };
}

/** Remove one accepted pair. Same-array-when-unchanged, like {@link addAcceptedIdentity}. */
export function removeAcceptedIdentity(
  current: readonly AcceptedIdentity[],
  pair: ComparePair,
  base: string,
  here: string,
): AcceptedIdentity[] {
  const next = current.filter((entry) => !(samePair(entry, pair) && entry.base === base && entry.here === here));
  return next.length === current.length ? (current as AcceptedIdentity[]) : next;
}

/** Record a refused pair. Returns the SAME array when it was already refused. */
export function rejectClaim(
  current: readonly RejectedClaim[],
  pair: ComparePair,
  base: string,
  here: string,
): RejectedClaim[] {
  if (current.some((r) => samePair(r, pair) && r.base === base && r.here === here)) {
    return current as RejectedClaim[];
  }
  return [
    ...current,
    {
      baseModelId: pair.baseModelId,
      headModelId: pair.headModelId,
      ...(pair.keyProperty !== undefined ? { keyProperty: pair.keyProperty } : {}),
      base,
      here,
    },
  ];
}

/**
 * The `keyAliases` map (head key → base key) the accepted list replays into
 * the next `diffModels` call. The list is kept 1:1 per pair by
 * {@link addAcceptedIdentity}, so no collision handling is needed here; a
 * conflicting IMPORTED file is refused at parse by the sidecar validator.
 */
export function keyAliasesFromAccepted(
  entries: readonly IdentityMapEntry[],
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const entry of entries) aliases.set(entry.here, entry.base);
  return aliases;
}

/** Signatures of every accepted pair, for hiding an accepted suggestion
 *  before the re-run that classifies it by key has landed. */
export function acceptedSignatures(entries: readonly IdentityMapEntry[]): ReadonlySet<string> {
  return new Set(entries.map((entry) => claimSignature(entry.base, entry.here)));
}
