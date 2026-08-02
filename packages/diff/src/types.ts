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
   * `added` or `deleted` are bucketed by ({@link EntityFingerprint.ifcType},
   * {@link EntityFingerprint.dataHash}) and re-examined. Within one bucket the
   * pass refines hierarchically — a real model is mostly *repeated*
   * components, so a bucket routinely holds many same-content entities that
   * differ only in where they sit:
   *
   * - **by world geometry hash.** Entities carrying a
   *   {@link EntityFingerprint.geometryHash} are sub-bucketed by it. A
   *   sub-bucket with one entity per side, or with the same count `N > 1` on
   *   both sides, is an unambiguous content match: the `added`/`deleted`
   *   entries are removed from {@link ModelDiff.entries} / `byKey` / `counts`
   *   (so they no longer read as a spurious add+delete) and reported instead
   *   as a single `renamed` {@link ContentMatch} in
   *   {@link ModelDiff.contentMatches}. For `N > 1`, every bijection is
   *   observationally identical in every field the engine can see, so the
   *   match carries all `N` entities per side rather than a guessed pairing.
   *   Geometry is not part of the *outer* bucket key: an entity that genuinely
   *   moved must still meet its counterpart.
   * - **1:1 leftover.** One base and one head left over in a bucket pair as
   *   `renamed` (geometry agrees, or geometry is out of scope), `moved`, or
   *   `reshaped` — see {@link ContentMatchKind} and {@link moveTolerance} /
   *   {@link reshapeTolerance} for how an {@link EntityFingerprint.aabb}
   *   separates the last two.
   * - **N:M leftover.** With an `aabb` on every candidate, leftovers are
   *   paired by *iterated mutual nearest neighbour* under
   *   {@link maxMoveDistance}: a base and a head pair only when each is the
   *   other's unique nearest, which abstains by construction on a symmetric
   *   layout rather than guessing. Whatever is still unpaired stays a
   *   reported group (below).
   *
   * Under {@link DiffScope} `'data'` geometry is out of the comparison
   * entirely, so no geometry sub-bucketing happens and every 1:1 match is
   * reported as `renamed`. The same applies under the capability abstention
   * described on {@link DiffScope}, which this pass shares with the key-based
   * one: when one revision carries geometry hashes and the other carries none
   * at all, geometry classifies nothing and every 1:1 match is `renamed` rather
   * than a model-wide sweep of `moved`.
   *
   *   Because this is the pass's only destructive path and `dataHash` is a
   *   64-bit FNV-1a value rather than a cryptographic digest, a pair is
   *   retired only if it also agrees on `ifcType` and — when both sides
   *   carry them — on every
   *   {@link EntityFingerprint.components} sub-hash. Neither check can reject
   *   a genuine match, and neither makes the pass collision-proof; see the
   *   "Hash collisions" section of `docs/guide/model-diff.md`.
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
  /**
   * Accepted identity claims, **head key → base key**, applied as key
   * normalization *before* the key-based pass indexes anything (issue #1891).
   *
   * This is the consuming half of {@link identityMapFromContentMatches}: a
   * previous comparison found that a re-GUIDed element is the same element, a
   * human accepted that, and the claim is replayed here so the pair is matched
   * by key rather than re-derived by content every single run. Because the
   * rename happens before indexing, an aliased pair is classified as
   * `modified`/`unchanged` by the ordinary key pass and never reaches
   * {@link matchUnpairedByContent} at all — it is not a candidate, so it cannot
   * appear in {@link ModelDiff.contentMatches}.
   *
   * The resulting {@link DiffEntry.key} is the **base** key; the head entity's
   * own key stays untouched on `entry.head.key`, so nothing is falsified — the
   * alias changes what the diff calls the pair, not what either file says.
   *
   * An alias is *ignored* (the head entity keeps its own key, exactly as if no
   * map had been supplied) when it points at a key no base entity holds, when
   * another head entity already holds the target key, or when two head entities
   * claim one base key. That last case is a collision, and on a collision the
   * alias loses and every colliding entity stays unaliased: a base entity is one
   * entity, so a map claiming otherwise is wrong, and the map is the only thing
   * that could have adjudicated. Refusing leaves the entities visible as
   * add/delete — what the caller would have seen without the map — instead of
   * silently dropping one. {@link ModelDiff.appliedKeyAliases} echoes back what
   * actually took effect.
   *
   * Composes with {@link excludeTypes} and every {@link scope}: aliasing only
   * decides *which entities are the same entity*, and both of those decide what
   * counts as a difference between two entities already known to be the same.
   * An alias onto an excluded base key drops the pair, which is what
   * `excludeTypes` means once the two are one entity.
   *
   * Default: no aliases — byte-identical results for existing callers.
   */
  keyAliases?: ReadonlyMap<string, string>;
  /**
   * Bounding-box-centre displacement (in the caller's units) below which a
   * content-matched pair counts as *not* moved. Default `2e-3`.
   *
   * Lifted deliberately from `MOVE_EPS` in the viewer's
   * `apps/viewer/src/lib/compare/describeChange.ts`, which encodes issue
   * #1197: a re-cut/re-tessellated wall that never moved reported a phantom
   * "moved 1.09 m". Below this, {@link ContentMatch.distance} is reported as
   * `0`, exactly as `describeChange` clamps it. Only used when both sides
   * carry an {@link EntityFingerprint.aabb}.
   */
  moveTolerance?: number;
  /**
   * Per-axis bounding-box *size* change (caller's units) above which a
   * content-matched pair counts as `reshaped` rather than `moved`. Default
   * `1e-3` — the same `RESHAPE_EPS` the viewer's `describeChange.ts` uses, so
   * the engine and the UI draw the move/reshape line in the same place. Only
   * used when both sides carry an {@link EntityFingerprint.aabb}.
   */
  reshapeTolerance?: number;
  /**
   * Maximum bounding-box-centre displacement (caller's units, so metres for a
   * metre-scale model) at which the mutual-nearest-neighbour pass will pair
   * two same-content entities. Default `10`: a building-scale relocation
   * pairs, a cross-site teleport stays `ambiguous` rather than being asserted
   * to be the same element. Only used when both sides carry an
   * {@link EntityFingerprint.aabb}.
   */
  maxMoveDistance?: number;
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
 * - `renamed`      — the base and head members share a data hash AND a world
 *   geometry hash: same content, same place, different key (re-GUID/rename).
 *   Usually one entity per side; a group of `N` per side is reported as one
 *   `renamed` match when both sides agree on both hashes `N` times over,
 *   because every bijection between them is then indistinguishable.
 * - `moved`        — one base and one head entity share a data hash but not a
 *   geometry hash, and their bounding boxes are the same size in every axis
 *   while their centres are further apart than `DiffOptions.moveTolerance`.
 *   Without an {@link EntityFingerprint.aabb} on both sides this is also what
 *   a bare geometry-hash difference reports, since nothing can tell a move
 *   from a reshape.
 * - `reshaped`     — one base and one head entity share a data hash but not a
 *   geometry hash, and their bounding boxes differ in size beyond
 *   `DiffOptions.reshapeTolerance` — or agree entirely, which is what a
 *   re-tessellation looks like. A bounding box genuinely cannot separate a
 *   re-tessellation from a reshape confined to the interior, and this kind
 *   does not pretend otherwise.
 * - `duplicated`   — one base entity's content matches several head entities
 *   (it looks like it was copied).
 * - `deduplicated` — several base entities' content matches one head entity
 *   (they look like they were merged into one).
 * - `ambiguous`    — several candidates remain on both sides with no
 *   principled pairing: the engine could not tell duplication from
 *   deduplication, or positions were symmetric enough that no base was any
 *   head's unique nearest neighbour, or the only candidates were further apart
 *   than `DiffOptions.maxMoveDistance`.
 */
export type ContentMatchKind =
  | 'renamed'
  | 'moved'
  | 'reshaped'
  | 'duplicated'
  | 'deduplicated'
  | 'ambiguous';

/**
 * A content-hash-based match (or ambiguous match group) among entities the
 * key-based pass classified as `added`/`deleted` (issue #1891).
 *
 * `renamed`, `moved`, and `reshaped` are *retiring* kinds: the corresponding
 * `added`/`deleted` {@link DiffEntry} pairs are removed from
 * {@link ModelDiff.entries} in favour of this record. `moved` and `reshaped`
 * always hold exactly one entity per side; `renamed` holds one per side except
 * for the same-data-and-geometry group described in {@link ContentMatchKind},
 * where it holds `N` per side.
 *
 * For `duplicated`, `deduplicated`, and `ambiguous`, `base`/`head` hold every
 * unresolved candidate, and those entities' `added`/`deleted` entries are left
 * in {@link ModelDiff.entries} untouched — the engine reports the grouping
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
  /**
   * Bounding-box-centre displacement base→head, in the caller's units.
   *
   * Present only on `moved`/`reshaped` matches whose two entities both carried
   * an {@link EntityFingerprint.aabb}. Reported as `0` below
   * {@link DiffOptions.moveTolerance}, mirroring the viewer's
   * `describeChange.ts` clamp (issue #1197): sub-tolerance jitter is
   * tessellation noise, not a move.
   */
  distance?: number;
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
}
