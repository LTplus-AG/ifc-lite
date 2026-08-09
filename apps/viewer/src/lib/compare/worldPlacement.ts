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
 * below) while leaving a real move (many orders above) plainly different. The
 * honest limitation of any grid is its boundaries: two revisions whose true
 * value straddles one snap apart despite being closer than the grid. Nothing
 * here can remove that; the grids are chosen so far below the smallest edit a
 * coordinator would make that landing on a boundary requires jitter of exactly
 * the wrong magnitude.
 *
 * Units are the file's own — the fingerprint is only ever compared against
 * another fingerprint from a model of the same pair, and a unit conversion
 * would just scale both sides. {@link composeWorldPlacement} likewise returns
 * native units; `describeChange.ts` applies `store.lengthUnitScale` when it
 * turns a displacement into the metres the panel shows.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import { stableHash } from '@ifc-lite/diff';
import type { IfcAttributeValue, IfcEntity } from '@ifc-lite/data';

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

/** One decoded entity — its STEP type name and attribute list — or `null`
 *  when it is not in this store. The type comes off the SOURCE (the extractor
 *  re-reads the STEP record), not `store.entities.getTypeName`: the entity
 *  table only carries rooted/relevant entities and answers 'Unknown' for the
 *  resource-level placement chain this module spends its whole life in. */
function entityOf(store: IfcDataStore, expressId: number): IfcEntity | null {
  const ref = store.entityIndex.byId.get(expressId) ?? store.deferredEntityIndex?.get(expressId);
  if (!ref) return null;
  return new EntityExtractor(store.source).extractEntity(ref);
}

/** Attribute list of one entity, or `null` when it is not in this store. */
function attributesOf(store: IfcDataStore, expressId: number): IfcAttributeValue[] | null {
  return entityOf(store, expressId)?.attributes ?? null;
}

/** An entity reference as an express id. The parser decodes `#123` to a bare
 *  number; entities created through the overlay editor carry the `'#123'`
 *  string form instead, so both are accepted (same rule as `placement-core.ts`).
 *  A STEP `$` arrives as `null` and answers `undefined`. */
function asRef(value: IfcAttributeValue | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.startsWith('#')) {
    const id = Number.parseInt(value.slice(1), 10);
    return Number.isFinite(id) ? id : undefined;
  }
  return undefined;
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
 * Build the row-major 4x4 an `IfcAxis2Placement3D` denotes.
 *
 * Follows the EXPRESS derivation: `Axis` is the local +Z (defaulting to global
 * +Z), `RefDirection` seeds the local +X and is Gram-Schmidt-orthogonalised
 * against Z, and +Y closes the right-handed frame as Z x X. An absent or
 * degenerate `RefDirection` falls back to a global axis that is not parallel to
 * Z, which is what an IFC viewer must do with `$`.
 */
function axisPlacementMatrix(
  store: IfcDataStore,
  expressId: number | undefined,
): number[] | undefined {
  if (expressId === undefined) return undefined;
  const attrs = attributesOf(store, expressId);
  if (!attrs) return undefined;
  // `Location` is a MANDATORY attribute, so an unreadable one — `$`, a
  // dangling reference, a non-numeric coordinate — is a malformed placement,
  // not a placement at the origin. Reading it as (0,0,0) would FABRICATE a
  // move the moment the other revision's location is real; abstaining is the
  // only answer that cannot. (`Axis`/`RefDirection` below genuinely are
  // optional, so those fall back per the EXPRESS derivation instead.)
  const location = triple(store, asRef(attrs[0]));
  if (!location) return undefined;
  const axis = triple(store, asRef(attrs[1]));
  const refDirection = triple(store, asRef(attrs[2]));

  const z = (axis && normalize(axis)) ?? [0, 0, 1];
  const seed = (refDirection && normalize(refDirection))
    ?? (Math.abs(z[0]) < 0.9 ? ([1, 0, 0] as const) : ([0, 1, 0] as const));
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
): WorldPlacement | undefined {
  // IfcProduct attribute 5 is ObjectPlacement.
  let placementId = asRef(attributesOf(store, localId)?.[5]);
  if (placementId === undefined) return undefined;

  // Collect the chain root-ward first, so the multiply runs parent-first and a
  // cycle is caught before any arithmetic happens. The depth cap is the whole
  // cycle guard: a self-referential chain simply exhausts it and abstains, and
  // a `seen` set alongside it would be a second spelling of one answer that no
  // test could tell apart from this one.
  const chain: number[] = [];
  while (placementId !== undefined) {
    if (chain.length >= MAX_CHAIN_DEPTH) return undefined;
    const entity = entityOf(store, placementId);
    if (!entity) return undefined;
    // Compose ONLY what is positively an `IfcLocalPlacement`. The other
    // concrete placement kinds carry positions this walk cannot reconstruct —
    // `IfcGridPlacement` by grid intersection, `IfcLinearPlacement` (IFC4x3)
    // by distance along an alignment curve — and reading either's attributes
    // as [PlacementRelTo, RelativePlacement] would compose a wrong-but-
    // plausible transform: for the linear case, one that reads an element
    // moved along its alignment as stationary, on the very infrastructure
    // models this module was measured against. A whitelist also covers
    // whatever placement kind a future schema adds, unseen.
    if (entity.type.toUpperCase() !== 'IFCLOCALPLACEMENT') return undefined;
    const attrs = entity.attributes;
    // IfcLocalPlacement: [0] = PlacementRelTo, [1] = RelativePlacement.
    if (asRef(attrs[1]) === undefined) return undefined;
    chain.push(placementId);
    placementId = asRef(attrs[0]);
  }

  let world: number[] | undefined;
  for (let index = chain.length - 1; index >= 0; index--) {
    const attrs = attributesOf(store, chain[index]!);
    const local = axisPlacementMatrix(store, asRef(attrs?.[1]));
    if (!local) return undefined;
    world = world ? multiply(world, local) : local;
  }
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
): string | undefined {
  const world = composeWorldPlacement(store, localId);
  if (!world) return undefined;
  const quantised: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 4; column++) {
      const value = world[row * 4 + column]!;
      quantised.push(snap(value, column === 3 ? TRANSLATION_GRID : BASIS_GRID));
    }
  }
  return `p:${stableHash(quantised.join(','))}`;
}
