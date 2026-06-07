/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification of an entity across two model revisions.
 *
 * - `added`     — present in head, absent from base
 * - `modified`  — present in both, but some in-scope signal differs ("edit")
 * - `deleted`   — present in base, absent from head
 * - `unchanged` — present in both, no in-scope difference
 */
export type DiffState = 'added' | 'modified' | 'deleted' | 'unchanged';

/** Which signal caused a `modified` classification. */
export type DiffChangeKind = 'data' | 'geometry';

/**
 * What kinds of difference count toward a `modified` classification.
 *
 * - `data`     — only attribute/property/quantity/type differences
 * - `geometry` — only mesh-shape/placement differences
 * - `both`     — either (default)
 *
 * This is the user-facing "compare data, geometry, or both" toggle.
 */
export type DiffScope = 'data' | 'geometry' | 'both';

/**
 * A geometry fingerprint. The WASM geometry hash surfaces as a `bigint`
 * (`MeshCollection.geometryHashValues` is a `BigUint64Array`); strings are
 * accepted for callers that fingerprint geometry another way. `undefined`
 * means the entity carries no geometry.
 */
export type GeometryHash = bigint | string;

/**
 * One entity's identity + fingerprints within a single model, as supplied by
 * a store adapter. The engine is store-agnostic: adapters extract these, the
 * engine matches and classifies.
 *
 * @typeParam TRef opaque, adapter-defined handle used to locate the entity
 *   downstream (e.g. a local express id or a federated global id). It is never
 *   inspected by the engine — it flows straight through to {@link DiffEntry}.
 */
export interface EntityFingerprint<TRef = unknown> {
  /** Stable cross-revision identity. Typically the IFC `GlobalId`. */
  key: string;
  /** IFC type name, compared verbatim (keep both sides in one casing). */
  ifcType: string;
  /**
   * Canonical hash of the entity's data (attributes + property sets +
   * quantity sets + type assignments). Build with `buildDataFingerprint`.
   */
  dataHash: string;
  /** Geometry fingerprint, or `undefined` when the entity has no geometry. */
  geometryHash?: GeometryHash;
  /** Adapter handle passed through to the diff entry. */
  ref: TRef;
}

export interface DiffOptions {
  /** What differences count as a modification. Default `'both'`. */
  scope?: DiffScope;
}

export interface DiffEntry<TRef = unknown> {
  /** The entity's stable key (its {@link EntityFingerprint.key}). */
  key: string;
  state: DiffState;
  /**
   * Which signals changed — non-empty only when `state === 'modified'`. Useful
   * for an inspect panel ("Geometry, Data") even though the colour is driven
   * by `state`.
   */
  changeKinds: DiffChangeKind[];
  /** The entity in the base revision (deleted / modified / unchanged). */
  base?: EntityFingerprint<TRef>;
  /** The entity in the head revision (added / modified / unchanged). */
  head?: EntityFingerprint<TRef>;
}

export interface DiffCounts {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
}

export interface ModelDiff<TRef = unknown> {
  /** The scope the diff was computed with. */
  scope: DiffScope;
  /** All entries, in no particular order. */
  entries: DiffEntry<TRef>[];
  /** Entries indexed by {@link DiffEntry.key} for O(1) lookup (picking). */
  byKey: Map<string, DiffEntry<TRef>>;
  counts: DiffCounts;
}
