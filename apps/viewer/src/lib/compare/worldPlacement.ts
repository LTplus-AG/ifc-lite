/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The composed world transform of a product's `ObjectPlacement`, and a
 * fingerprint of it, for the entities the geometry pass produced nothing for.
 *
 * **Why this exists.** A meshed element carries its placement inside the WASM
 * geometry hash: the vertices it hashes are already world-positioned, so moving
 * the element moves the hash and Compare reports it. A product with no
 * representation has no such hash, so on a measured two-revision infrastructure
 * pair an entire `IfcSite` was re-georeferenced — translated 40 m and turned
 * 60 degrees, taking its whole subtree with it — and Compare reported nothing
 * at all. This closes that hole, and only that hole: it is applied exclusively
 * to the geometry-less population (`buildFingerprints.ts`), never to a meshed
 * entity whose real hash is strictly better evidence.
 *
 * **The subtlety that makes it dangerous, and how it is handled.** The rule is
 * COMPOSE, then compare — walk the whole `PlacementRelTo` chain and fingerprint
 * the product, never the local `RelativePlacement` on its own. In the file this
 * was measured on, the same re-georeferencing rewrote the placement
 * *expression* of three further `IfcSite`s that did not move a millimetre: the
 * translation simply migrated between a parent link and a child link. A local
 * comparison flags all three. Re-georeferencing is routine, so a tool that does
 * that cries wolf on every corrected model — strictly worse than the silence it
 * replaces. `worldPlacementFingerprint` is byte-identical for those three,
 * which is what `worldPlacement.test.ts` pins first and hardest.
 *
 * **Tolerance is expressed by quantisation**, because the consumer is a hash
 * channel and a hash cannot express "close enough". Coordinates are snapped to
 * {@link TRANSLATION_GRID} and basis entries to {@link BASIS_GRID} before
 * hashing, which absorbs re-export float jitter (many orders of magnitude
 * below) while leaving a real move (many orders above) plainly different — and
 * a translation is first rounded to {@link TRANSLATION_SIGNIFICANT_DIGITS},
 * because at a georeferenced easting the fixed grid alone would sit BELOW
 * double precision. The
 * honest limitation of any grid is its boundaries: two revisions whose true
 * value straddles one snap apart despite being closer than the grid. Nothing
 * here can remove that; the grids are chosen so far below the smallest edit a
 * coordinator would make that landing on a boundary requires jitter of exactly
 * the wrong magnitude.
 *
 * {@link composeWorldPlacement} returns native (per-file) units, but the
 * viewer's compare lets a user pair any two loaded models — including a base
 * and head exported with different length-unit presets, which is a routine
 * re-export change and not a same-pair guarantee. `worldPlacementFingerprint`
 * therefore scales each translation by `store.lengthUnitScale` before
 * quantising, the same normalisation `describeChange.ts` / `geometrySummary.ts`
 * already apply when turning a displacement into the metres the panel shows —
 * so two fingerprints agree on a real-world-identical placement regardless of
 * which file's native unit produced the raw coordinate.
 *
 * **Relation to `packages/export/src/lod0-generator.ts`.** The LOD0 exporter
 * carries its own placement composer over the same EXPRESS derivation. They are
 * deliberately NOT shared: the viewer must not depend on `@ifc-lite/export`,
 * and the two sit on opposite failure policies — an exporter substitutes
 * best-effort defaults so it always produces geometry, where a comparison must
 * abstain rather than fabricate a frame two revisions might fabricate
 * differently. Both handle the `IfcAxis2Placement2D` form of
 * `RelativePlacement`.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import { stableHash } from '@ifc-lite/diff';
import type { IfcAttributeValue, IfcEntity } from '@ifc-lite/data';
import { asExpressIdRef } from '../placement-core.js';

/**
 * A composed placement as a **row-major** 4x4, 16 numbers: the basis in the
 * upper-left 3x3 and the translation in the last column (indices 3, 7, 11).
 * Same layout and reading convention as `MeshData.localToWorld` — but NOT the
 * same frame or units: this matrix is in IFC's Z-up axes and the file's native
 * length unit, where `localToWorld` is WebGL Y-up metres.
 */
export type WorldPlacement = readonly number[];

/** Snap grid for translations, in the file's native length unit. */
const TRANSLATION_GRID = 1e-6;
/**
 * Significant decimal digits a translation keeps before the absolute snap.
 *
 * The absolute grid alone is below double precision for a georeferenced
 * coordinate: a millimetre-unit file on a national grid carries ~1e9, where
 * one ulp is ~1.2e-7 — half a 1e-6 cell — so re-associating the chain's
 * multiplications (exactly what re-georeferencing does) could re-bucket a
 * position that had not moved. Rounding to 12 significant digits caps the
 * resolution at ~5e-12 RELATIVE — ~3 orders above the double noise a short
 * chain of multiplies accumulates (~1e-15 relative), and at 1e9 exactly 0.01
 * native units, far below the smallest edit a coordinator makes.
 *
 * Deliberately NOT a magnitude-relative snap grid (`grid = |x| * eps`): that
 * makes `round(x / grid)` a CONSTANT `1/eps` wherever the relative term
 * dominates, erasing the translation from the fingerprint entirely — the
 * "still reports a real move at georeferenced magnitude" control pins the
 * difference.
 */
const TRANSLATION_SIGNIFICANT_DIGITS = 12;
/** Snap grid for basis (rotation) entries, which are direction cosines. */
const BASIS_GRID = 1e-9;

/**
 * How many `PlacementRelTo` links to follow before giving up.
 *
 * A real spatial chain is a handful of links deep. The limit is not there for
 * depth, it is there for CYCLES: a malformed or hand-edited file can point a
 * placement at itself, and this cap is the only thing standing between that
 * file and an unbounded walk inside the compare pass. Hitting it abstains
 * (returns `undefined`) rather than returning a partial product, because a
 * partially-composed transform is a wrong answer that looks like a right one —
 * and abstaining is also the right answer for a genuinely 64-deep chain, which
 * no real model has.
 */
const MAX_CHAIN_DEPTH = 64;

/** One extractor per store, reused across every node read: the extractor is a
 *  stateless reader over `store.source`, and a placement pass touches thousands
 *  of chain nodes — allocating one per read multiplied garbage for nothing.
 *  Keyed weakly by the store so an unloaded model releases its extractor. */
const extractorByStore = new WeakMap<IfcDataStore, EntityExtractor>();

/** One decoded entity — its STEP type name and attribute list — or `null`
 *  when it is not in this store. The type comes off the SOURCE (the extractor
 *  re-reads the STEP record), not `store.entities.getTypeName`: the entity
 *  table only carries rooted/relevant entities and answers 'Unknown' for the
 *  resource-level placement chain this module spends its whole life in. */
function entityOf(store: IfcDataStore, expressId: number): IfcEntity | null {
  const ref = store.entityIndex.byId.get(expressId) ?? store.deferredEntityIndex?.get(expressId);
  if (!ref) return null;
  let extractor = extractorByStore.get(store);
  if (!extractor) {
    extractor = new EntityExtractor(store.source);
    extractorByStore.set(store, extractor);
  }
  return extractor.extractEntity(ref);
}

/** Attribute list of one entity, or `null` when it is not in this store. */
function attributesOf(store: IfcDataStore, expressId: number): IfcAttributeValue[] | null {
  return entityOf(store, expressId)?.attributes ?? null;
}

/** An entity reference as an express id — `placement-core.ts`'s rule
 *  (`asExpressIdRef`: bare number from the parser, `'#123'` string from the
 *  overlay editor), imported rather than restated, with its `null` mapped to
 *  this module's `undefined`-means-abstain convention. A STEP `$` arrives as
 *  `null` and answers `undefined`. */
function asRef(value: IfcAttributeValue | undefined): number | undefined {
  return asExpressIdRef(value ?? null) ?? undefined;
}

/** One numeric attribute member, unwrapping the parser's `{ real }` box. */
function asNumber(value: IfcAttributeValue | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'real' in value) {
    const real = (value as { real: number }).real;
    return typeof real === 'number' ? real : undefined;
  }
  return undefined;
}

/**
 * The `Coordinates` of an `IfcCartesianPoint` or the `DirectionRatios` of an
 * `IfcDirection`, padded to three components. IFC permits the 2D forms, and a
 * 2D point in a 3D placement means z = 0 rather than "unusable".
 *
 * Not `placement-core.ts`'s `asCoordinateTriple`: that one reads bare numbers
 * from an in-memory attribute graph, where this reads the extractor's decoded
 * form (which boxes reals as `{ real }`) and must ABSTAIN on a non-finite
 * member rather than coerce it — the two differ in exactly the ways this
 * module's failure policy demands.
 */
function triple(
  store: IfcDataStore,
  expressId: number | undefined,
): [number, number, number] | undefined {
  if (expressId === undefined) return undefined;
  const raw = attributesOf(store, expressId)?.[0];
  // An empty coordinate list is not a 0D point at the origin, it is a
  // malformed entity — abstain like any other unreadable value.
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    if (axis >= raw.length) break;
    const value = asNumber(raw[axis]);
    // A non-finite or non-numeric coordinate is not a placement we can compose
    // from; abstaining is the only answer that cannot fabricate a move.
    if (value === undefined || !Number.isFinite(value)) return undefined;
    out[axis] = value;
  }
  return out;
}

/** Unit vector, or `undefined` for a degenerate one. */
function normalize(v: readonly [number, number, number]): [number, number, number] | undefined {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(length) || length === 0) return undefined;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * Build the row-major 4x4 an `IfcAxis2Placement` denotes — `RelativePlacement`
 * is that SELECT, so both concrete forms must be read, each by its OWN
 * attribute layout:
 *
 * - `IfcAxis2Placement3D` — `[Location, Axis, RefDirection]`. The EXPRESS
 *   derivation: `Axis` is the local +Z (defaulting to global +Z),
 *   `RefDirection` seeds the local +X and is Gram-Schmidt-orthogonalised
 *   against Z, and +Y closes the right-handed frame as Z x X.
 * - `IfcAxis2Placement2D` — `[Location, RefDirection]`, only TWO attributes.
 *   The plane normal IS global +Z and `RefDirection` turns the frame about it.
 *   Reading this layout positionally as the 3D one takes the 2D RefDirection
 *   for the local +Z — a wrong-but-plausible frame, and a phantom geometry
 *   change the moment one revision migrates the placement to the 3D spelling.
 *
 * Anything else — a dangling reference, a non-placement entity, whatever a
 * future schema adds — ABSTAINS, the same whitelist rule
 * {@link composeWorldPlacement} applies one level up.
 */
function axisPlacementMatrix(
  store: IfcDataStore,
  expressId: number | undefined,
): number[] | undefined {
  if (expressId === undefined) return undefined;
  const entity = entityOf(store, expressId);
  if (!entity) return undefined;
  const type = entity.type.toUpperCase();
  if (type !== 'IFCAXIS2PLACEMENT3D' && type !== 'IFCAXIS2PLACEMENT2D') return undefined;
  const attrs = entity.attributes;
  // `Location` is a MANDATORY attribute, so an unreadable one — `$`, a
  // dangling reference, a non-numeric coordinate — is a malformed placement,
  // not a placement at the origin. Reading it as (0,0,0) would FABRICATE a
  // move the moment the other revision's location is real; abstaining is the
  // only answer that cannot. (`Axis`/`RefDirection` below genuinely are
  // optional, so those fall back per the EXPRESS derivation instead.)
  const location = triple(store, asRef(attrs[0]));
  if (!location) return undefined;
  // 2D: no Axis attribute exists; attrs[1] is the (2D) RefDirection.
  const axis = type === 'IFCAXIS2PLACEMENT3D' ? triple(store, asRef(attrs[1])) : undefined;
  const refDirection = triple(store, asRef(type === 'IFCAXIS2PLACEMENT3D' ? attrs[2] : attrs[1]));

  const z = (axis && normalize(axis)) ?? [0, 0, 1];
  // EXPRESS `IfcFirstProjAxis` with a NIL argument: project global X — for
  // EVERY Axis that is not parallel to it (zero cross product, i.e. no
  // component off the X axis at all) — and only then fall back to global Y.
  // Not a nearness heuristic: for an Axis of (0.95, 0.31, 0) the standard
  // still projects [1,0,0], and a threshold that switches early diverges from
  // every writer that spells the default explicitly. One edge is decided
  // rather than derived: for the ANTI-parallel axis [-1,0,0] the standard's
  // own projection degenerates (it literal-compares against [1,0,0] only), so
  // the derivation is indeterminate there — this code takes the global-Y seed
  // for both ±X, which both revisions compute identically, so no diff can
  // arise from the choice.
  const seed = (refDirection && normalize(refDirection))
    ?? (z[1] === 0 && z[2] === 0 ? ([0, 1, 0] as const) : ([1, 0, 0] as const));
  const dot = seed[0] * z[0] + seed[1] * z[1] + seed[2] * z[2];
  const x = normalize([seed[0] - z[0] * dot, seed[1] - z[1] * dot, seed[2] - z[2] * dot]);
  // A RefDirection parallel to Axis leaves nothing to orthogonalise. The file
  // is malformed; abstaining beats inventing an X axis of our own choosing,
  // because the two revisions might invent different ones.
  if (!x) return undefined;
  const y: [number, number, number] = [
    z[1] * x[2] - z[2] * x[1],
    z[2] * x[0] - z[0] * x[2],
    z[0] * x[1] - z[1] * x[0],
  ];
  return [
    x[0], y[0], z[0], location[0],
    x[1], y[1], z[1], location[1],
    x[2], y[2], z[2], location[2],
    0, 0, 0, 1,
  ];
}

/** Row-major 4x4 product, `a` applied after `b` (i.e. parent x child). */
function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[row * 4 + k]! * b[k * 4 + column]!;
      out[row * 4 + column] = sum;
    }
  }
  return out;
}

/**
 * The composed world transform of `localId`'s `ObjectPlacement`, walking the
 * whole `PlacementRelTo` chain to its root.
 *
 * `undefined` means "no world placement this comparison can speak about", and
 * is returned for a product with no `ObjectPlacement`, for a chain that reaches
 * an `IfcGridPlacement` or `IfcLinearPlacement` (positioned by grid
 * intersection / distance along an alignment, neither reconstructible here),
 * for a malformed axis placement (including an unreadable mandatory
 * `Location`), and for a cyclic chain. A caller must treat it as an
 * abstention, not as the identity transform.
 *
 * Abstention is one-sided by nature: a chain that composes in one revision and
 * abstains in the other reads downstream as a geometry change (`p:…` against
 * `undefined`), exactly as if the placement had been removed. That is accepted
 * — the placement genuinely was restructured into a form this comparison
 * cannot follow, and staying silent about it would be the old bug again.
 */
export function composeWorldPlacement(
  store: IfcDataStore,
  localId: number,
  cache?: PlacementComposeCache,
): WorldPlacement | undefined {
  // IfcProduct attribute 5 is ObjectPlacement.
  const placementId = asRef(attributesOf(store, localId)?.[5]);
  if (placementId === undefined) return undefined;
  return composeChain(store, placementId, 0, cache) ?? undefined;
}

/**
 * A per-build memo of composed transforms, keyed by placement express id, with
 * `null` recording an abstention. Products of one model share their spatial
 * ancestry — every element under one `IfcBuildingStorey` walks the identical
 * parent chain — so without this the storey's chain is recomposed once per
 * descendant, and on the port-dominated MEP models `compareScope.ts` names
 * that is most of the placement pass. Owned by the CALLER and scoped to one
 * `buildEntityFingerprints` run, never module-lifetime: the overlay editor can
 * append entities between runs, and a build-scoped map cannot go stale.
 */
export type PlacementComposeCache = Map<number, WorldPlacement | null>;

/** Compose one placement's world transform, memoized per placement id.
 *  `null` is the CACHEABLE abstention — a property of the placement itself.
 *  `undefined` is the depth-capped abstention, which is a property of where
 *  the walk STARTED (a node reached at depth 63 from one product may compose
 *  fine at depth 2 from another), so it is neither cached for this node nor
 *  allowed to cache an abstention onto the nodes below it. */
function composeChain(
  store: IfcDataStore,
  placementId: number,
  depth: number,
  cache: PlacementComposeCache | undefined,
): WorldPlacement | null | undefined {
  // The depth cap is the whole cycle guard: a self-referential chain simply
  // exhausts it and abstains, and a `seen` set alongside it would be a second
  // spelling of one answer that no test could tell apart from this one.
  // Checked BEFORE the memo, so a walk that exceeds the cap abstains no
  // matter what other products already composed: honouring a cache hit here
  // would make a >64-deep chain's answer depend on the enumeration order that
  // happened to warm the cache — the iterative walk this replaced was
  // deterministic, and this must be too.
  if (depth >= MAX_CHAIN_DEPTH) return undefined;
  const cached = cache?.get(placementId);
  if (cached !== undefined) return cached;
  const abstain = (): null => {
    cache?.set(placementId, null);
    return null;
  };
  const entity = entityOf(store, placementId);
  if (!entity) return abstain();
  // Compose ONLY what is positively an `IfcLocalPlacement`. The other
  // concrete placement kinds carry positions this walk cannot reconstruct —
  // `IfcGridPlacement` by grid intersection, `IfcLinearPlacement` (IFC4x3)
  // by distance along an alignment curve — and reading either's attributes
  // as [PlacementRelTo, RelativePlacement] would compose a wrong-but-
  // plausible transform: for the linear case, one that reads an element
  // moved along its alignment as stationary, on the very infrastructure
  // models this module was measured against. A whitelist also covers
  // whatever placement kind a future schema adds, unseen.
  if (entity.type.toUpperCase() !== 'IFCLOCALPLACEMENT') return abstain();
  // IfcLocalPlacement: [0] = PlacementRelTo, [1] = RelativePlacement.
  const attrs = entity.attributes;
  const local = axisPlacementMatrix(store, asRef(attrs[1]));
  if (!local) return abstain();
  const parentId = asRef(attrs[0]);
  if (parentId === undefined) {
    cache?.set(placementId, local);
    return local;
  }
  const parent = composeChain(store, parentId, depth + 1, cache);
  // A depth-capped parent poisons nothing: propagate the uncacheable form.
  if (parent === undefined) return undefined;
  if (parent === null) return abstain();
  const world = multiply(parent, local);
  cache?.set(placementId, world);
  return world;
}

/** Snap to a grid, normalising `-0` to `0` so two equal placements cannot
 *  differ by a sign bit alone. */
function snap(value: number, grid: number): number {
  const snapped = Math.round(value / grid);
  return snapped === 0 ? 0 : snapped;
}

/**
 * A stable fingerprint of `localId`'s composed world placement, or `undefined`
 * when {@link composeWorldPlacement} abstains.
 *
 * The `p:` prefix keeps this out of the value space of the WASM geometry hash,
 * whose string form is decimal digits: the two ride the same
 * `EntityFingerprint.geometryHash` field, and a placement fingerprint must
 * never be able to collide with a real mesh hash.
 */
export function worldPlacementFingerprint(
  store: IfcDataStore,
  localId: number,
  cache?: PlacementComposeCache,
): string | undefined {
  const world = composeWorldPlacement(store, localId, cache);
  if (!world) return undefined;
  // The viewer's compare can pair two models loaded with different length
  // units (a routine unit-preset change on re-export, or two models from
  // different tools) — see the module note above. Translations are scaled to
  // metres by the same `lengthUnitScale` `geometrySummary.ts` already applies
  // before quantising, so two fingerprints from the same real-world placement
  // agree regardless of which file's native unit produced the raw value.
  // Basis entries are direction cosines and are unit-independent.
  const unitScale = store.lengthUnitScale ?? 1;
  const quantised: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 4; column++) {
      const value = world[row * 4 + column]!;
      // Translations lose sub-significant digits first (georeferenced files,
      // see TRANSLATION_SIGNIFICANT_DIGITS); basis entries are direction
      // cosines, bounded by 1, so their absolute grid alone is already far
      // above double noise.
      quantised.push(
        column === 3
          ? snap(
              Number((value * unitScale).toPrecision(TRANSLATION_SIGNIFICANT_DIGITS)),
              TRANSLATION_GRID,
            )
          : snap(value, BASIS_GRID),
      );
    }
  }
  return `p:${stableHash(quantised.join(','))}`;
}
