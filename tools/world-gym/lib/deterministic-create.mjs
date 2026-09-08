/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Seeded determinism options for @ifc-lite/create - the first-class
 * replacement for the deleted deterministic-runtime.mjs shim, which
 * monkey-patched `globalThis.Date` / `crypto.randomUUID` before IfcCreator
 * grew `ProjectParams.Timestamp` + `ProjectParams.GuidSource` (PR #1879).
 *
 * BYTE-COMPAT CONTRACT: the corpus is pinned by seed - benchmark results
 * and the determinism re-proofs depend on every seed producing the exact
 * bytes the shim produced. The shim's fake `crypto.randomUUID` drew 32 hex
 * nibbles per UUID (`Math.floor(rng.float() * 16)` each, NO v4
 * version/variant forcing) from `Rng('guid:' + seed)`, and IfcCreator's
 * unseeded path returned that UUID verbatim before encoding it with
 * `uuidToIfcGuid`. `seededGuidSource` reproduces exactly that stream and
 * encoding, and `FIXED_EPOCH_MS` is the shim's pinned instant - so
 * `deterministicCreateParams(seed)` yields byte-identical files for every
 * seed. Do NOT "fix" the GUID stream to proper v4 UUIDs (e.g. via
 * `generateIfcGuid(random)`, which draws 16 bytes and forces the
 * version/variant bits): that changes every GlobalId in the corpus.
 *
 * THE GUID STREAM TAKES THE SALT TOO (B4.3), and it is not an afterthought.
 * GlobalIds are the one stream whose output is printed verbatim into the file,
 * so an unsalted `guid:${seed}` stream would remain a public, exact readout of
 * a salted model: the attacker computes the whole GUID sequence for the seed,
 * compares it to the served bytes, and every rooted entity the corruption layer
 * DELETED shows up as a hole in an otherwise contiguous sequence - a free
 * `missing-site` detector that needs no twin and no salt. Salting it closes
 * that. `deterministicCreateParams(seed)` with no salt is unchanged, so the
 * public corpus keeps its exact GlobalIds.
 */

import { Rng } from './rng.mjs';

// Guarded like checks.mjs: a static import of a workspace dist turns a missing
// build into an opaque module-not-found at load time, which is a confusing
// first experience in a fresh worktree. Fail with the fix instead.
let uuidToIfcGuid;
try {
  ({ uuidToIfcGuid } = await import('../../../packages/encoding/dist/index.js'));
} catch (err) {
  throw new Error(
    `world-gym seeded generation needs the built workspace artifacts (packages/encoding/dist). Run 'pnpm build' at the repo root first. Underlying error: ${err.message}`,
  );
}

/** Arbitrary fixed instant baked into every generated file's header/owner-history. */
export const FIXED_EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

/**
 * Seeded GlobalId source for `ProjectParams.GuidSource`: replays the shim's
 * `guid:${seed}` nibble stream (32 draws per GUID, in element-creation
 * order) and encodes with the same canonical `uuidToIfcGuid`.
 */
export function seededGuidSource(seed, salt = '') {
  const rng = new Rng(`guid:${seed}`, salt);
  return () => {
    let hex = '';
    for (let i = 0; i < 32; i++) {
      hex += Math.floor(rng.float() * 16).toString(16);
    }
    return uuidToIfcGuid(hex);
  };
}

/**
 * The `ProjectParams` fields that pin one IfcCreator build to `seed`:
 * spread into the constructor params.
 */
export function deterministicCreateParams(seed, salt = '') {
  return {
    Timestamp: FIXED_EPOCH_MS,
    GuidSource: seededGuidSource(seed, salt),
  };
}
