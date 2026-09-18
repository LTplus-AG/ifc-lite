/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The identity-map **sidecar**: a JSON artifact carrying identity claims for
 * plain-file workflows (issue #1891).
 *
 * A layer-based workflow keeps its identity map inside the layer's provenance
 * manifest (`03-provenance.md` §3.1), where it is pinned to a specific base by
 * `base.id`. Two loose `.ifc` files on a disk have no such anchor, so the
 * sidecar supplies one: it records the content digest of BOTH revisions the
 * claims were derived from and verified against.
 *
 * That pinning is the whole point of the format. A bare list of
 * `old GlobalId → new GlobalId` pairs is not a trustworthy claim, because
 * nothing in it says which two files a human looked at when they accepted it.
 * Replay it against a different pair and it either does nothing (the aliases go
 * stale and are dropped) or, worse, quietly asserts an identity nobody ever
 * reviewed. {@link identityMapSidecarMismatches} is how a consumer refuses that
 * before a single alias is applied.
 *
 * The format is intentionally boring JSON: a human reviews these, and a review
 * artifact that needs a tool to read is not reviewed.
 */

import type { IdentityMapEntry } from './identity-map.js';
import {
  compareCodeUnits as compare,
  normalizeModelIdentity,
  pinnedModelMismatches,
  validateCreated,
  validateKeyProperty,
  validateModelIdentity,
  type ModelIdentity,
} from './sidecar-common.js';

export type { ModelIdentity } from './sidecar-common.js';

/** Discriminator so a stray JSON file is rejected rather than misread. */
export const IDENTITY_MAP_SIDECAR_FORMAT = 'ifc-lite/identity-map';

/**
 * Sidecar format version. Bumped only for a breaking change to the shape; a
 * consumer must refuse a version it does not know rather than guess, which is
 * why {@link validateIdentityMapSidecar} pins it exactly.
 */
export const IDENTITY_MAP_SIDECAR_VERSION = 1;

/**
 * The version a sidecar carrying a {@link IdentityMapSidecar.keyProperty} is
 * written under (issue #4955). A version-1 consumer ignores unknown fields and
 * applies the entries under its own GlobalId scheme; for a map whose keys were
 * taken under an authored property that is precisely the silent misapplication
 * the key-scheme check exists to prevent, so such a map is stamped a version the
 * old consumer refuses outright. A map with no `keyProperty` stays version 1,
 * byte-identical to before.
 */
export const IDENTITY_MAP_SIDECAR_KEYED_VERSION = 2;

/**
 * A reviewed set of identity claims, scoped to the exact pair of revisions it
 * was verified against.
 */
export interface IdentityMapSidecar {
  format: typeof IDENTITY_MAP_SIDECAR_FORMAT;
  /** `1`, or `2` when {@link keyProperty} is present. */
  version: typeof IDENTITY_MAP_SIDECAR_VERSION | typeof IDENTITY_MAP_SIDECAR_KEYED_VERSION;
  /** The base ("old") revision the claims resolve `entries[].base` against. */
  base: ModelIdentity;
  /** The head ("new") revision the claims resolve `entries[].here` against. */
  head: ModelIdentity;
  /** ISO 8601 creation timestamp, when the producer supplied one. */
  created?: string;
  /**
   * The key scheme the entries' `base`/`here` keys were taken under (issue
   * #4955): an authored property such as `Pset_Asset.AssetId`, or `Tag`.
   * Absent means GlobalId, so a version-1 file written before the field
   * existed is still valid. {@link identityMapSidecarMismatches} reports a
   * scheme mismatch like a digest mismatch, because a GlobalId-keyed map
   * replayed under an authored key would otherwise apply nothing, silently.
   */
  keyProperty?: string;
  /** The claims, sorted by (`base`, `here`) for a reviewable, stable file. */
  entries: IdentityMapEntry[];
}

export interface IdentityMapSidecarInit {
  base: ModelIdentity;
  head: ModelIdentity;
  entries: readonly IdentityMapEntry[];
  /** ISO 8601 timestamp. Omitted entirely when not supplied — the sidecar is
   *  content-addressed by the two model digests, not by when it was written,
   *  and stamping `Date.now()` by default would make two runs over the same
   *  pair produce different bytes for no reason. */
  created?: string;
  /** See {@link IdentityMapSidecar.keyProperty}. */
  keyProperty?: string;
}

/**
 * Build a sidecar, sorting and de-duplicating the entries.
 *
 * Sorting makes the artifact stable: the same comparison writes the same bytes,
 * so a checked-in sidecar produces an empty git diff when nothing changed.
 * De-duplication is by (`base`, `here`) — the identical claim arriving twice is
 * not a conflict.
 *
 * Two *different* claims are handled by side, because the two conflicts are not
 * the same kind of thing:
 *
 * - Two `here`s on one `base` stay in. That document is not self-contradictory
 *   against every pair of files: one of the two head entities may have been
 *   deleted since, leaving a single live claim that is simply true.
 *   {@link resolveKeyAliases} knows the models and adjudicates it (rule 4);
 *   resolving it here would hide a fault the consumer can actually judge.
 * - Two `base`s on one `here` is refused outright by
 *   {@link validateIdentityMapSidecar}, so this throws. See that function.
 *
 * @throws if the result is not a valid sidecar.
 */
export function createIdentityMapSidecar(init: IdentityMapSidecarInit): IdentityMapSidecar {
  const seen = new Set<string>();
  const entries: IdentityMapEntry[] = [];
  for (const entry of init.entries) {
    // NUL separator, as in `content-match.ts`'s bucket key: an entity identity
    // never contains one, so no (base, here) pair can be confused with another.
    const signature = `${entry.base}\u0000${entry.here}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    entries.push({ base: entry.base, here: entry.here, reason: entry.reason });
  }
  entries.sort((a, b) => (a.base === b.base ? compare(a.here, b.here) : compare(a.base, b.base)));

  const sidecar: IdentityMapSidecar = {
    format: IDENTITY_MAP_SIDECAR_FORMAT,
    version:
      init.keyProperty !== undefined ? IDENTITY_MAP_SIDECAR_KEYED_VERSION : IDENTITY_MAP_SIDECAR_VERSION,
    base: normalizeModelIdentity(init.base),
    head: normalizeModelIdentity(init.head),
    entries,
  };
  if (init.created !== undefined) sidecar.created = init.created;
  if (init.keyProperty !== undefined) sidecar.keyProperty = init.keyProperty;

  const errors = validateIdentityMapSidecar(sidecar);
  if (errors.length > 0) {
    throw new Error(`Invalid identity-map sidecar: ${errors.join('; ')}`);
  }
  return sidecar;
}

/** Serialize to the on-disk form: pretty-printed JSON with a trailing newline,
 *  because these files are read and reviewed by humans and land in git. */
export function serializeIdentityMapSidecar(sidecar: IdentityMapSidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/**
 * Parse and validate an on-disk sidecar.
 *
 * @throws with every structural problem listed, on malformed JSON or an invalid
 *   document. A partially-understood identity map is worse than none: it would
 *   apply the claims it could read and silently skip the rest.
 */
export function parseIdentityMapSidecar(text: string): IdentityMapSidecar {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid identity-map sidecar: not JSON (${(error as Error).message})`);
  }
  const errors = validateIdentityMapSidecar(value);
  if (errors.length > 0) {
    throw new Error(`Invalid identity-map sidecar: ${errors.join('; ')}`);
  }
  return value as IdentityMapSidecar;
}

/**
 * Structural validation of an untrusted value. Returns a list of problems;
 * empty means valid. Mirrors `validateProvenance` in `@ifc-lite/ifcx`, down to
 * the `identity_map`-entry rule, so the two artifacts accept the same claims.
 */
export function validateIdentityMapSidecar(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['sidecar must be an object'];
  }
  const sidecar = value as Record<string, unknown>;

  if (sidecar.format !== IDENTITY_MAP_SIDECAR_FORMAT) {
    errors.push(`format must be "${IDENTITY_MAP_SIDECAR_FORMAT}"`);
  }
  if (sidecar.version !== IDENTITY_MAP_SIDECAR_VERSION && sidecar.version !== IDENTITY_MAP_SIDECAR_KEYED_VERSION) {
    errors.push(`version must be ${IDENTITY_MAP_SIDECAR_VERSION} or ${IDENTITY_MAP_SIDECAR_KEYED_VERSION}`);
  } else if ((sidecar.keyProperty !== undefined) !== (sidecar.version === IDENTITY_MAP_SIDECAR_KEYED_VERSION)) {
    // The version IS the statement "these keys are not GlobalIds"; the two
    // must agree or a hand-edited file could smuggle a scheme past an old reader.
    errors.push(`version ${IDENTITY_MAP_SIDECAR_KEYED_VERSION} requires keyProperty and version ${IDENTITY_MAP_SIDECAR_VERSION} forbids it`);
  }
  for (const side of ['base', 'head'] as const) {
    errors.push(...validateModelIdentity(sidecar[side], side));
  }
  errors.push(...validateCreated(sidecar.created));
  errors.push(...validateKeyProperty(sidecar.keyProperty));
  if (!Array.isArray(sidecar.entries)) {
    errors.push('entries must be an array');
  } else {
    let shaped = true;
    for (const entry of sidecar.entries) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>).base !== 'string' ||
        typeof (entry as Record<string, unknown>).here !== 'string' ||
        typeof (entry as Record<string, unknown>).reason !== 'string'
      ) {
        errors.push('entries must be { base, here, reason } with string fields');
        shaped = false;
        break;
      }
    }
    if (shaped) errors.push(...contradictoryClaims(sidecar.entries as IdentityMapEntry[]));
  }
  return errors;
}

/**
 * Head keys that two entries claim two different base identities for.
 *
 * Such a document is **self-contradictory, not merely inconvenient**: both
 * entries are about the same head entity, and it cannot be two base entities.
 * Unlike the mirror-image conflict (two `here`s on one `base`, which
 * {@link resolveKeyAliases} rule 4 resolves against the models because one of
 * the two head entities may since have been deleted), there is no pair of files
 * against which this document is coherent. Nothing the consumer learns from the
 * models can break the tie, so deferring it just moves the guess downstream.
 *
 * Refusing the whole document is the same stance {@link parseIdentityMapSidecar}
 * already takes on an unknown version or a malformed entry: a
 * partially-understood identity map is worse than none, because it silently
 * applies the half it happened to read. Applying the first claim would be
 * exactly the arbitrary winner the rest of this design refuses to pick — worse
 * here than elsewhere, because a `--identity-in x --identity-out x` run writes
 * the winner back out and the coin flip becomes the record.
 *
 * One error per conflicted key, sorted, so a reviewer sees every contradiction
 * at once rather than fixing them one run at a time.
 */
function contradictoryClaims(entries: readonly IdentityMapEntry[]): string[] {
  const claimed = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const entry of entries) {
    const previous = claimed.get(entry.here);
    if (previous === undefined) claimed.set(entry.here, entry.base);
    else if (previous !== entry.base) conflicted.add(entry.here);
  }
  return [...conflicted]
    .sort(compare)
    .map((here) => `entries claim two different base identities for here "${here}"`);
}

/**
 * Check a sidecar against the two revisions it is about to be applied to.
 * Returns a list of problems; empty means the sidecar was verified against
 * exactly these two files.
 *
 * Only {@link ModelIdentity.hash} and the key scheme ({@link
 * IdentityMapSidecar.keyProperty}) are compared. A caller that wants to apply a
 * map anyway (a deliberate, logged override) can ignore the result — but it has
 * to do so explicitly, which is the point.
 */
export function identityMapSidecarMismatches(
  sidecar: IdentityMapSidecar,
  models: { base: ModelIdentity; head: ModelIdentity; keyProperty?: string },
): string[] {
  return pinnedModelMismatches(sidecar, models, 'sidecar');
}

/**
 * Convert a sidecar into the head-key → base-key map
 * {@link DiffOptions.keyAliases} takes.
 *
 * Self-claims (`base === here`) are dropped as no-ops.
 *
 * A `here` claimed by two different `base`s yields **nothing at all** for that
 * key. {@link validateIdentityMapSidecar} already refuses such a document, so
 * this cannot arrive from {@link parseIdentityMapSidecar}; it is the same rule
 * restated for a caller that hand-built the object, and it is restated rather
 * than assumed because "first claim wins" would silently pick an arbitrary
 * identity — the one thing this whole path exists to never do. Dropping the key
 * costs that entity its alias and leaves it as the add/delete a human can act
 * on, which is precisely the fallback {@link resolveKeyAliases} takes on a
 * collision.
 *
 * The conflict is detected *before* self-claims are dropped: `{ base: 'x',
 * here: 'x' }` alongside `{ base: 'b', here: 'x' }` is two different claims
 * about `x`, and treating the self-claim as invisible would let the other one
 * through as the arbitrary winner.
 *
 * A repeated `base` is left alone, because that collision is precisely what
 * `resolveKeyAliases` refuses against the actual models (it would put two head
 * entities on one base entity), and resolving it here would hide a fault the
 * consumer can judge with evidence this function does not have.
 */
export function keyAliasesFromSidecar(sidecar: IdentityMapSidecar): Map<string, string> {
  const claims = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const entry of sidecar.entries) {
    const claimed = claims.get(entry.here);
    if (claimed === undefined) claims.set(entry.here, entry.base);
    else if (claimed !== entry.base) conflicted.add(entry.here);
  }

  const aliases = new Map<string, string>();
  for (const [here, base] of claims) {
    if (conflicted.has(here)) continue;
    if (base === here) continue;
    aliases.set(here, base);
  }
  return aliases;
}
