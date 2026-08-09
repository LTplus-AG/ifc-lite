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
 *
 * Selecting geometry is a request, not a guarantee: when one revision carries
 * geometry hashes and the other carries none at all, geometry classifies
 * nothing regardless of scope. Every entity's one-sided `undefined` would
 * otherwise read as a difference and the whole model would report as changed on
 * what is a difference between two fingerprinting runs. Under `'geometry'` that
 * abstention leaves every matched entity `unchanged`; under `'both'` the data
 * channel is unaffected.
 */
export type DiffScope = 'data' | 'geometry' | 'both';

/**
 * A geometry fingerprint. The WASM geometry hash surfaces as a `bigint`
 * (`MeshCollection.geometryHashValues` is a `BigUint64Array`); strings are
 * accepted for callers that fingerprint geometry another way. `undefined`
 * means the entity carries no geometry.
 *
 * **Both revisions must use the same representation.** Equality is `String(a)
 * === String(b)`, so a `bigint` matches its own decimal string form (`42n` and
 * `'42'`) but nothing else: `'0x2a'` is a *different* fingerprint from `42n`.
 * The engine deliberately does not try to parse or canonicalize string forms,
 * because a string hash is an opaque token from the caller's own scheme and
 * reinterpreting one that happens to look numeric would collide it with an
 * unrelated `bigint`.
 *
 * Content matching's first tier sub-buckets on `String(hash)`, which is where
 * mixing representations costs the most: `42n` and `'42'` land in one
 * sub-bucket and retire as `renamed`, while `42n` and `'0x2a'` land in two, so
 * that tier resolves neither. They are not lost — they fall to the bucket's
 * residue, where a 1:1 leftover still pairs and {@link ContentMatchKind}s as
 * `moved`/`reshaped`, and a larger residue can end up an `ambiguous` group. So
 * the cost of mixing is a missed `renamed` and a spurious geometry difference,
 * not an unpairable entity.
 */
export type GeometryHash = bigint | string;

/**
 * An axis-aligned bounding box in **world space**, in the caller's units.
 *
 * Same contract as {@link EntityFingerprint.geometryHash}: both revisions must
 * be expressed in the *same* frame. The engine compares base and head boxes
 * numerically and never re-projects them, so a base fingerprinted in a
 * georeferenced frame and a head fingerprinted in a local one produce
 * meaningless displacements rather than an error. Feed both sides from the
 * same pipeline.
 */
export interface EntityAabb {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

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
  /**
   * Geometry fingerprint, or `undefined` when the entity has no geometry.
   *
   * A one-sided `undefined` on a matched entity is a geometry change (geometry
   * added or removed) — *unless* one whole revision carries no geometry hashes
   * at all while the other does, which is a capability difference between two
   * fingerprinting runs rather than a model change. Geometry then classifies
   * nothing, in both matching passes; see {@link DiffScope}.
   */
  geometryHash?: GeometryHash;
  /**
   * Optional world-space bounding box, in the caller's units and frame (see
   * {@link EntityAabb}). Used only by the content-keyed matching pass
   * ({@link DiffOptions.matchUnpairedByContent}), where it separates a move
   * from a reshape and lets a group of same-content entities be paired by
   * position. Absent on either side, that pass falls back to reporting a
   * geometry-hash difference as a bare `moved`.
   */
  aabb?: EntityAabb;
  /**
   * Optional enclosed volume of the entity's geometry, in the caller's units
   * cubed and — like {@link aabb} — measured by the same pipeline on both
   * revisions. Used only by the split/merge detector
   * ({@link DiffOptions.detectSplitMerge}).
   *
   * **Absent means NOT PROVED, never zero and never "differs".** The producer
   * this contract was written against (`MeshCollection.geometryVolumeValues`)
   * emits a value only where the meshed geometry was provably a single closed,
   * orientable, single-component solid; an open shell, a material-layered wall
   * or a multi-item assembly correctly reports nothing. Roughly a third of a
   * real model's elements carry no volume, by design.
   *
   * The engine treats that asymmetrically, which is the whole reason the field
   * can be sparse and still be useful: a volume is required to be COMPLETE
   * before it can confirm a claim, but a PARTIAL sum can already refute one —
   * if the volumes we do know already exceed the whole, the unknowns cannot
   * bring the total back down.
   *
   * A `NaN`, a zero or a negative value here is not a volume and the engine
   * ignores it exactly as if the field were absent. Resolve your producer's
   * absent-sentinel at the boundary rather than passing one through.
   */
  volume?: number;
  /**
   * Opt-in per-componentKey sub-hashes (`attr:core`, `pset:<Name>`,
   * `qset:<Name>`, `type-assignment`). Build with
   * `buildComponentFingerprints`. When both sides of a diff carry them,
   * {@link DiffEntry.changedComponents} reports which components differ.
   */
  components?: Record<string, string>;
  /** Adapter handle passed through to the diff entry. */
  ref: TRef;
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
  /**
   * Component keys whose sub-hash differs between base and head. Present
   * only when both fingerprints carry `components` (sub-hash mode); a key
   * present on one side only counts as changed.
   */
  changedComponents?: string[];
}

export interface DiffCounts {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
}

/**
 * The options, and the reporting records of the two opt-in matching passes,
 * live in their own modules for size and are re-exported here so `./types.js`
 * stays the single import site for the whole contract. Type-only in every
 * direction: nothing in this file emits a runtime import.
 */
export type { DiffOptions } from './diff-options.js';
export type { ContentMatch, ContentMatchKind, ContentMatchTier } from './content-match-types.js';
export type {
  SplitMergeClaim,
  SplitMergeConfidence,
  SplitMergeKind,
} from './split-merge-types.js';

import type { ContentMatch } from './content-match-types.js';
import type { SplitMergeClaim } from './split-merge-types.js';

export interface ModelDiff<TRef = unknown> {
  /** The scope the diff was computed with. */
  scope: DiffScope;
  /**
   * The IFC type names actually excluded from this diff ({@link DiffOptions.excludeTypes}),
   * normalized to upper case and deduplicated. Empty when nothing was excluded.
   * Echoed here so a consumer (report export, provenance) can state what the
   * comparison ignored without re-deriving it.
   */
  excludedTypes: string[];
  /** All entries, in no particular order. */
  entries: DiffEntry<TRef>[];
  /** Entries indexed by {@link DiffEntry.key} for O(1) lookup (picking). */
  byKey: Map<string, DiffEntry<TRef>>;
  counts: DiffCounts;
  /**
   * The {@link DiffOptions.keyAliases} entries that actually took effect (head
   * key → base key). Only present (possibly empty) when `keyAliases` was
   * supplied; `undefined` otherwise.
   *
   * Echoed for the same reason as {@link excludedTypes}: an alias that was
   * dropped as stale or colliding changes nothing about the result, so without
   * this a caller cannot tell "the map matched" from "the map was ignored".
   * A report or provenance record can state which claims it relied on rather
   * than re-deriving them.
   */
  appliedKeyAliases?: Map<string, string>;
  /**
   * Content-hash matches and ambiguous groups found among the leftover
   * `added`/`deleted` entities (issue #1891). Only present (possibly empty)
   * when {@link DiffOptions.matchUnpairedByContent} was `true`; `undefined`
   * for a plain key-based diff.
   */
  contentMatches?: ContentMatch<TRef>[];
  /**
   * Split / merge claims found among the entities still `added`/`deleted` after
   * content matching (issue #1891). Only present (possibly empty) when
   * {@link DiffOptions.detectSplitMerge} was `true` AND the run had geometry to
   * reason with; `undefined` otherwise.
   *
   * Purely additive: `entries`, `byKey` and `counts` are exactly what they
   * would have been with the option off. See {@link SplitMergeClaim}.
   */
  splitMerges?: SplitMergeClaim<TRef>[];
}
