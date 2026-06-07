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

export { diffModels } from './diff.js';
export {
  buildDataFingerprint,
  normalizeValue,
  stableHash,
} from './fingerprint.js';
export type {
  DataFingerprintInput,
  PropertyEntryInput,
  PropertySetInput,
  QuantitySetInput,
  TypeAssignmentInput,
} from './fingerprint.js';
export type {
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
