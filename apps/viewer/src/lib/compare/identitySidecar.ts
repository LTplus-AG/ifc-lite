/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's sidecar round-trip (issue #4955): export the reviewed
 * identity map and the lineage, import an identity map back.
 *
 * Both sidecars are pinned to the two models by a content digest, so a file
 * written for one revision pair cannot be replayed onto another. The digest is
 * the same one the CLI's `modelIdentityOf` writes, `sha256:<hex>` over the
 * file bytes, so a sidecar exported here is accepted by `ifc-lite diff
 * --identity-in` and vice versa. The viewer's `sourceContentHash` is a
 * different, chunked digest (placement identity) and cannot stand in for it,
 * so the digest is computed on demand from the model's `sourceFile` and
 * cached per file.
 */

import {
  createIdentityMapSidecar,
  createLineageSidecar,
  identityMapSidecarMismatches,
  lineageOfDiff,
  parseIdentityMapSidecar,
  serializeIdentityMapSidecar,
  serializeLineageSidecar,
  type IdentityMapEntry,
  type LineageEntry,
  type ModelIdentity,
} from '@ifc-lite/diff';
import type { FederatedModel } from '../../store/types.js';
import type { CompareResult } from '../../store/slices/compareSlice.js';
import { computeFullSourceHashFromBlob } from '../../utils/sourceContentHash.js';
import { downloadBlob, sanitizeFilename } from '../export/download.js';
import { acceptedSignatures, claimSignature } from './acceptedIdentity.js';

const digests = new WeakMap<Blob, Promise<string | null>>();

/**
 * `sha256:<hex>` of the model's source bytes, or `null` when there are no
 * bytes to digest (a cache-restored model, a composed IFCX layer) or the
 * platform has no SubtleCrypto (insecure context).
 */
export function modelDigest(model: FederatedModel): Promise<string | null> {
  const source = model.sourceFile;
  if (!source) return Promise.resolve(null);
  let pending = digests.get(source);
  if (!pending) {
    pending = computeFullSourceHashFromBlob(source).then((hex) => (hex ? `sha256:${hex}` : null));
    digests.set(source, pending);
  }
  return pending;
}

/** The two pinned identities a sidecar is written against, or the reason
 *  they cannot be produced (shown to the user; nothing is exported then). */
export async function comparedModelIdentities(
  result: Pick<CompareResult, 'baseModelId' | 'headModelId'>,
  models: ReadonlyMap<string, FederatedModel>,
): Promise<{ base: ModelIdentity; head: ModelIdentity } | { error: string }> {
  const out: Partial<Record<'base' | 'head', ModelIdentity>> = {};
  for (const [side, id] of [['base', result.baseModelId], ['head', result.headModelId]] as const) {
    const model = models.get(id);
    if (!model) return { error: `Version ${side === 'base' ? 'A' : 'B'} is no longer loaded.` };
    const hash = await modelDigest(model);
    if (!hash) {
      return {
        error: `Cannot digest ${model.name}: the file bytes are not available (restored from cache or composed), so the sidecar cannot be pinned to it.`,
      };
    }
    out[side] = { hash, path: model.name };
  }
  return { base: out.base!, head: out.head! };
}

function sidecarFilename(result: CompareResult, suffix: string): string {
  const name = (s: string) => sanitizeFilename(s, { fallback: 'model', maxLength: 40 });
  return `compare-${name(result.baseName)}-vs-${name(result.headName)}.${suffix}.json`;
}

/** Write the accepted identity map as `ifc-lite/identity-map` v1. */
export function downloadIdentityMapSidecar(
  result: CompareResult,
  identities: { base: ModelIdentity; head: ModelIdentity },
  accepted: readonly IdentityMapEntry[],
): void {
  const sidecar = createIdentityMapSidecar({
    ...identities,
    entries: accepted,
    created: new Date().toISOString(),
  });
  downloadBlob(
    new Blob([serializeIdentityMapSidecar(sidecar)], { type: 'application/json;charset=utf-8;' }),
    sidecarFilename(result, 'identity-map'),
  );
}

/**
 * The lineage of a comparison as the panel exports it: the engine's committed
 * identity entries and split / merge claims, the successor claims the user
 * accepted as `replaced`, and the base keys left deleted with no lineage
 * (what a rekey orphans).
 *
 * An accepted successor is in `diff.successors` only until the re-diff
 * replays it as a key alias; from then on the engine reports it under
 * `appliedKeyAliases`, and `lineageOfDiff` carries an applied alias forward
 * with whatever reason `aliasReasons` gives it. The relation is decided by
 * the engine from the reason prefix (see {@link LineageEntry.reason}): an
 * alias whose reason says it was an accepted successor (`successor:
 * <confidence>`) comes back as `replaced` already, so the artifact reads the
 * same before and after the re-diff without any re-labelling here. A pair
 * accepted out of an ambiguous group (`accepted:ambiguous`) is an identity
 * claim and stays one.
 */
export function lineageForExport(
  result: CompareResult,
  accepted: readonly IdentityMapEntry[],
): { entries: LineageEntry[]; deleted: string[] } {
  const signatures = acceptedSignatures(accepted);
  const acceptedClaims = (result.diff.successors ?? []).filter((claim) =>
    signatures.has(claimSignature(claim.base.key, claim.head.key)),
  );
  const aliasReasons = new Map(accepted.map((entry) => [entry.here, entry.reason]));
  return lineageOfDiff(result.diff, { accepted: acceptedClaims, aliasReasons });
}

/** Write the lineage as `ifc-lite/lineage` v1 (see {@link lineageForExport}). */
export function downloadLineageSidecar(
  result: CompareResult,
  identities: { base: ModelIdentity; head: ModelIdentity },
  accepted: readonly IdentityMapEntry[],
): void {
  const { entries, deleted } = lineageForExport(result, accepted);
  const sidecar = createLineageSidecar({ ...identities, entries, deleted, created: new Date().toISOString() });
  downloadBlob(
    new Blob([serializeLineageSidecar(sidecar)], { type: 'application/json;charset=utf-8;' }),
    sidecarFilename(result, 'lineage'),
  );
}

/**
 * Read an identity-map sidecar for the compared pair. Returns its entries, or
 * the reason it was refused: malformed, or pinned to other model bytes than
 * the two loaded here (`identityMapSidecarMismatches`).
 */
export function readIdentityMapSidecar(
  text: string,
  identities: { base: ModelIdentity; head: ModelIdentity },
): { entries: IdentityMapEntry[] } | { error: string } {
  let sidecar;
  try {
    sidecar = parseIdentityMapSidecar(text);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const mismatches = identityMapSidecarMismatches(sidecar, identities);
  if (mismatches.length > 0) return { error: `Sidecar refused: ${mismatches.join('; ')}` };
  return { entries: sidecar.entries };
}
