/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/diff` — headless model-diff engine.
 *
 * Classifies entities across two IFC revisions as added / modified / deleted /
 * unchanged, with separable data-vs-geometry scope. Store-agnostic: adapters
 * (CLI, viewer) extract {@link EntityFingerprint}s and feed them to
 * {@link diffModels}; geometry hashes come from the WASM mesh pass
 * (`MeshCollection.geometryHashValues`).
 */

export { compareWithWasm as diffModels } from './wasm-diff.js';
export { DiffModelHandle, prepareDiffModel } from './prepared-model.js';
export { initDiff, initDiffSync } from './wasm-runtime.js';
export {
  buildComponentFingerprints,
  buildDataFingerprint,
  normalizeValue,
  stableHash,
} from './wasm-fingerprint.js';
export {
  ACCEPTED_AMBIGUOUS_REASON,
  CONTENT_MATCH_REASON_PREFIX,
  SUCCESSOR_REASON_PREFIX,
} from './identity-map.js';
export { identityMapFromContentMatches, identityMapFromSuccessors, lineageOfDiff, lineageFromDiff } from './wasm-provenance.js';
export type { IdentityMapEntry } from './identity-map.js';
export {
  keyAliasesFromLineage,
  lineageConflicts,
  rekeyByLineage,
} from './wasm-lineage.js';
export type { Lineage, LineageEntry, LineageFromDiffOptions, LineageRelation, RekeyPolicy, RekeyResult } from './lineage.js';
export {
  LINEAGE_SIDECAR_FORMAT,
  LINEAGE_SIDECAR_VERSION,
  createLineageSidecar,
  lineageSidecarMismatches,
  parseLineageSidecar,
  serializeLineageSidecar,
  validateLineageSidecar,
  type LineageSidecar,
  type LineageSidecarInit,
} from './wasm-lineage-sidecar.js';
export {
  IDENTITY_MAP_SIDECAR_FORMAT,
  IDENTITY_MAP_SIDECAR_KEYED_VERSION,
  IDENTITY_MAP_SIDECAR_VERSION,
  createIdentityMapSidecar,
  identityMapSidecarMismatches,
  keyAliasesFromSidecar,
  parseIdentityMapSidecar,
  serializeIdentityMapSidecar,
  validateIdentityMapSidecar,
} from './wasm-identity-sidecar.js';
export type {
  IdentityMapSidecar,
  IdentityMapSidecarInit,
  ModelIdentity,
} from './identity-sidecar.js';
export type {
  ComponentKey,
  DataFingerprintInput,
  PropertyEntryInput,
  PropertySetInput,
  QuantitySetInput,
  TypeAssignmentInput,
} from './fingerprint.js';
export type {
  ContentMatch,
  ContentMatchKind,
  SplitMergeClaim,
  SplitMergeConfidence,
  SplitMergeKind,
  SuccessorClaim,
  SuccessorConfidence,
  ContentMatchTier,
  EntityAabb,
  DiffChangeKind,
  DiffCounts,
  DiffEntry,
  DiffOptions,
  DiffScope,
  DiffState,
  EntityFingerprint,
  GeometryHash,
  ModelDiff,
} from './types.js';
