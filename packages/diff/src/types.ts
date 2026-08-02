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

export interface DiffOptions {
  /** What differences count as a modification. Default `'both'`. */
  scope?: DiffScope;
  /**
   * IFC type names to leave out of the comparison entirely - a "blacklist" of
   * classes the user does not want considered as changes (e.g.
   * `IfcOpeningElement`, which is only the connective void between a wall and a
   * removed window, not a meaningful change in its own right - issue #1470).
   *
   * An entity is dropped from the comparison if its {@link EntityFingerprint.ifcType}
   * matches in EITHER revision, so it never appears in {@link ModelDiff.entries},
   * {@link ModelDiff.byKey}, or {@link ModelDiff.counts} - as if it were in neither
   * model. Using the union of both sides means a cross-version re-class (e.g.
   * `IfcWall` -> `IfcWallStandardCase` with `IfcWall` excluded) can't leak the
   * entity back as a phantom add/delete. Matching is case-insensitive and ignores
   * surrounding whitespace so a hand-typed `ifcopeningelement` still matches.
   * Empty / whitespace-only names are ignored. Default: nothing excluded.
   */
  excludeTypes?: Iterable<string>;
  /**
   * Opt-in second matching pass (issue #1891): GlobalIds are unreliable
   * across a from-scratch re-export — every element gets a new GlobalId, so a
   * pure key diff reports the whole model as deleted-and-added even when
   * nothing substantive changed.
   *
   * When `true`, after the normal key-based pass, entities that came out
   * `added` or `deleted` are bucketed by {@link EntityFingerprint.dataHash}
   * and re-examined:
   *
   * - a bucket with exactly one leftover base entity and one leftover head
   *   entity is an unambiguous content match: the two `added`/`deleted`
   *   entries are removed from {@link ModelDiff.entries} / `byKey` / `counts`
   *   (so they no longer read as a spurious add+delete) and reported instead
   *   as a single `renamed`/`moved` {@link ContentMatch} in
   *   {@link ModelDiff.contentMatches} — `renamed` if the geometry hash also
   *   agrees (only the identity changed), `moved` if it differs.
   * - a bucket with more than one entity on either side is genuinely
   *   ambiguous: one base entity could have become several head entities
   *   ("duplicated"), several base entities could have collapsed into one head
   *   entity ("deduplicated"), or, with more than one on both sides, there is
   *   no principled way to tell which of the above happened, let alone which
   *   specific base entity corresponds to which head entity ("ambiguous"). The
   *   engine does not guess: the original `added`/`deleted` entries are left
   *   untouched in `entries`, and the whole bucket is additionally reported as
   *   a {@link ContentMatch} so the caller can resolve it (e.g. surface the
   *   group in a UI) rather than the engine silently picking one (see #1923,
   *   a shipped `?? candidates[0]` bug of exactly that shape).
   *
   * Split and Merged (a *partial* geometric overlap between one entity and
   * several others) are deliberately out of scope: they need a
   * geometric-similarity threshold and a policy for partial overlap that has
   * no single correct answer, and are left for a follow-up.
   *
   * `DiffState`/`DiffEntry` are unchanged by this option — a content match is
   * reported only via {@link ModelDiff.contentMatches}, never by inventing a
   * new `DiffEntry.state`, so existing exhaustive switches over `DiffState`
   * stay exhaustive. Default `false` — existing callers get byte-identical
   * results.
   */
  matchUnpairedByContent?: boolean;
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
 * How a {@link ContentMatch} relates its `base` and `head` members (issue
 * #1891, `DiffOptions.matchUnpairedByContent`):
 *
 * - `renamed`      — exactly one base and one head entity share a data hash
 *   AND a geometry hash: same content, different key (re-GUID/rename).
 * - `moved`        — exactly one base and one head entity share a data hash
 *   but NOT a geometry hash: same content, different key, and it moved.
 * - `duplicated`   — one base entity's content matches several head entities
 *   (it looks like it was copied).
 * - `deduplicated` — several base entities' content matches one head entity
 *   (they look like they were merged into one).
 * - `ambiguous`    — more than one entity on *both* sides shares the content
 *   hash; there is no principled way to tell duplication from deduplication,
 *   let alone which specific base entity corresponds to which head entity.
 */
export type ContentMatchKind = 'renamed' | 'moved' | 'duplicated' | 'deduplicated' | 'ambiguous';

/**
 * A content-hash-based match (or ambiguous match group) among entities the
 * key-based pass classified as `added`/`deleted` (issue #1891). For `renamed`
 * and `moved`, `base`/`head` each hold exactly one entity, and the
 * corresponding `added`/`deleted` {@link DiffEntry} pair is removed from
 * {@link ModelDiff.entries} in favor of this record. For `duplicated`,
 * `deduplicated`, and `ambiguous`, `base`/`head` hold every entity in the
 * bucket, and those entities' `added`/`deleted` entries are left in
 * {@link ModelDiff.entries} untouched — the engine reports the grouping
 * instead of guessing a 1:1 pairing (see #1923).
 */
export interface ContentMatch<TRef = unknown> {
  kind: ContentMatchKind;
  /** The shared {@link EntityFingerprint.dataHash} that grouped these entities. */
  dataHash: string;
  /** Base-revision entities in this match/group. */
  base: EntityFingerprint<TRef>[];
  /** Head-revision entities in this match/group. */
  head: EntityFingerprint<TRef>[];
}

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
   * Content-hash matches and ambiguous groups found among the leftover
   * `added`/`deleted` entities (issue #1891). Only present (possibly empty)
   * when {@link DiffOptions.matchUnpairedByContent} was `true`; `undefined`
   * for a plain key-based diff.
   */
  contentMatches?: ContentMatch<TRef>[];
}
