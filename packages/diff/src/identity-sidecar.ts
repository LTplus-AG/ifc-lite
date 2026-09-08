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

/** Discriminator so a stray JSON file is rejected rather than misread. */
export const IDENTITY_MAP_SIDECAR_FORMAT = 'ifc-lite/identity-map';

/**
 * Sidecar format version. Bumped only for a breaking change to the shape; a
 * consumer must refuse a version it does not know rather than guess, which is
 * why {@link validateIdentityMapSidecar} pins it exactly.
 */
export const IDENTITY_MAP_SIDECAR_VERSION = 1;

/**
 * Which model a set of claims was derived from.
 *
 * {@link hash} is the load-bearing field: an opaque `<algorithm>:<hex>` content
 * digest of the model bytes (the CLI writes `sha256:…`). {@link path} is a
 * convenience for humans reading the file and is never compared — paths move,
 * and a comparison on one would reject a valid map for the wrong reason while
 * accepting an edited file at the same path.
 */
export interface ModelIdentity {
  /** Content digest of the model bytes, `<algorithm>:<hex>`. */
  hash: string;
  /** Path or file name the digest was taken from. Informational only. */
  path?: string;
}

/**
 * A reviewed set of identity claims, scoped to the exact pair of revisions it
 * was verified against.
 */
export interface IdentityMapSidecar {
  format: typeof IDENTITY_MAP_SIDECAR_FORMAT;
  version: typeof IDENTITY_MAP_SIDECAR_VERSION;
  /** The base ("old") revision the claims resolve `entries[].base` against. */
  base: ModelIdentity;
  /** The head ("new") revision the claims resolve `entries[].here` against. */
  head: ModelIdentity;
  /** ISO 8601 creation timestamp, when the producer supplied one. */
  created?: string;
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
    version: IDENTITY_MAP_SIDECAR_VERSION,
    base: normalizeModelIdentity(init.base),
    head: normalizeModelIdentity(init.head),
    entries,
  };
  if (init.created !== undefined) sidecar.created = init.created;

  const errors = validateIdentityMapSidecar(sidecar);
  if (errors.length > 0) {
    throw new Error(`Invalid identity-map sidecar: ${errors.join('; ')}`);
  }
  return sidecar;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeModelIdentity(identity: ModelIdentity): ModelIdentity {
  const normalized: ModelIdentity = { hash: identity.hash };
  if (identity.path !== undefined) normalized.path = identity.path;
  return normalized;
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
  if (sidecar.version !== IDENTITY_MAP_SIDECAR_VERSION) {
    errors.push(`version must be ${IDENTITY_MAP_SIDECAR_VERSION}`);
  }
  for (const side of ['base', 'head'] as const) {
    const identity = sidecar[side];
    if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
      errors.push(`${side} must be { hash, path? }`);
      continue;
    }
    const record = identity as Record<string, unknown>;
    if (typeof record.hash !== 'string' || record.hash.length === 0) {
      errors.push(`${side}.hash must be a non-empty content digest`);
    }
    if (record.path !== undefined && typeof record.path !== 'string') {
      errors.push(`${side}.path must be a string when present`);
    }
  }
  if (sidecar.created !== undefined) {
    if (typeof sidecar.created !== 'string' || Number.isNaN(Date.parse(sidecar.created))) {
      errors.push('created must be an ISO 8601 timestamp when present');
    }
  }
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
 * Only {@link ModelIdentity.hash} is compared. A caller that wants to apply a
 * map anyway (a deliberate, logged override) can ignore the result — but it has
 * to do so explicitly, which is the point.
 */
export function identityMapSidecarMismatches(
  sidecar: IdentityMapSidecar,
  models: { base: ModelIdentity; head: ModelIdentity },
): string[] {
  const problems: string[] = [];
  for (const side of ['base', 'head'] as const) {
    if (sidecar[side].hash !== models[side].hash) {
      problems.push(
        `${side} model does not match the sidecar (sidecar ${sidecar[side].hash}, got ${models[side].hash})`,
      );
    }
  }
  return problems;
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
