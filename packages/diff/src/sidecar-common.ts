/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pieces the identity-map sidecar (`identity-sidecar.ts`) and the lineage
 * sidecar (`lineage-sidecar.ts`) share: the model-identity pinning that makes
 * either artifact a reviewed claim about two SPECIFIC files, its validation,
 * and the ordering the two use to write stable bytes.
 *
 * Kept as one module rather than two copies so the two artifacts cannot drift
 * on what "the same two files" means.
 */

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

/** Locale-independent code-unit ordering, as everywhere in this package. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeModelIdentity(identity: ModelIdentity): ModelIdentity {
  const normalized: ModelIdentity = { hash: identity.hash };
  if (identity.path !== undefined) normalized.path = identity.path;
  return normalized;
}

/** Problems with one `base`/`head` slot of a sidecar; empty means valid. */
export function validateModelIdentity(value: unknown, side: 'base' | 'head'): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${side} must be { hash, path? }`];
  }
  const errors: string[] = [];
  const record = value as Record<string, unknown>;
  if (typeof record.hash !== 'string' || record.hash.length === 0) {
    errors.push(`${side}.hash must be a non-empty content digest`);
  }
  if (record.path !== undefined && typeof record.path !== 'string') {
    errors.push(`${side}.path must be a string when present`);
  }
  return errors;
}

/** Problems with an optional `created` stamp; empty means valid or absent. */
export function validateCreated(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return ['created must be an ISO 8601 timestamp when present'];
  }
  return [];
}

/**
 * Problems with an optional `keyProperty` (the authored-key scheme the entries'
 * keys were taken under, e.g. `Pset_Asset.AssetId` or `Tag`; absent means
 * GlobalId). Empty means valid or absent.
 */
export function validateKeyProperty(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return ['keyProperty must be a non-empty string when present'];
  }
  return [];
}

/**
 * Compare a pinned pair of model identities (and key scheme) against the pair
 * a caller is about to apply the artifact to. Only {@link ModelIdentity.hash}
 * is compared, plus the key scheme: an identity map written under GlobalId
 * keys replayed under an authored key would apply nothing, silently, because
 * no alias target would exist in the base — so a scheme mismatch is reported
 * like a digest mismatch rather than discovered as an empty result.
 */
export function pinnedModelMismatches(
  pinned: { base: ModelIdentity; head: ModelIdentity; keyProperty?: string },
  models: { base: ModelIdentity; head: ModelIdentity; keyProperty?: string },
  artifact: string,
): string[] {
  const problems: string[] = [];
  for (const side of ['base', 'head'] as const) {
    if (pinned[side].hash !== models[side].hash) {
      problems.push(
        `${side} model does not match the ${artifact} (${artifact} ${pinned[side].hash}, got ${models[side].hash})`,
      );
    }
  }
  if ((pinned.keyProperty ?? '') !== (models.keyProperty ?? '')) {
    problems.push(
      `key scheme does not match the ${artifact} (${artifact} ${pinned.keyProperty ?? 'GlobalId'}, got ${models.keyProperty ?? 'GlobalId'})`,
    );
  }
  return problems;
}
