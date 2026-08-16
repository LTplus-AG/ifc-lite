/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Duplicate / fully-overlapping element detection (#1280).
 *
 * The first thing people do when reviewing a single discipline model is hunt for
 * accidentally duplicated or coincident objects — re-imported geometry, a wall
 * pasted twice, a column modelled on top of another. That is *not* a discipline
 * clash, so it gets its own lightweight pass: AABB proximity decides *what* is
 * reported, and a tessellation-invariant shape signature (surface area +
 * enclosed volume) decides only whether a reported pair is labelled an exact
 * duplicate. No narrow-phase triangle-vs-triangle work. The broad phase is a
 * one-axis sort-and-sweep, which handles mixed-scale models correctly (no grid
 * cell size to mis-tune), so it is cheap enough to run on every load; the
 * signature is computed lazily, only for pairs that already coincide. Matching
 * on AABBs has a known limit for nested solids — see the "nested-solids limit"
 * section on {@link findDuplicates} for exactly what it can and cannot tell
 * apart.
 *
 * "Same object" is decided by {@link boxDistance} against `positionTolerance`, a
 * plain distance in metres. It used to be AABB intersection-over-union ≥ 0.9,
 * which is a ratio and so carried no physical tolerance at all: the same setting
 * allowed 5 mm across a DN100 pipe and 421 mm across an 8 m slab (see
 * `DuplicateOptions.iouThreshold`).
 *
 * Output is a normal {@link ClashResult} (rule id `duplicates`) so the existing
 * panel, grouping and BCF export render it with no special-casing. It is
 * *pairwise*: N coincident copies of one object yield N(N−1)/2 clashes. For a
 * reader-facing list use `groupDuplicateSets`, which collapses those pairs into
 * one finding per coincident set.
 */

import { center, overlapBounds } from './math/aabb.js';
import { boxDistance, boxesTouch, minExtent, similarity } from './duplicate-metric.js';
import { sameShape, shapeSignature, type ShapeSignature } from './shape-signature.js';
import { isExcluded, qualifiedKey } from './exclude.js';
import type {
  Clash,
  ClashElement,
  ClashElementRef,
  ClashResult,
  ClashRule,
  ClashSeverity,
  ClashSummary,
  ExclusionSet,
} from './types.js';

export interface DuplicateOptions {
  /**
   * How far apart (m) two elements may be and still count as the same object.
   * This is the primary control and the number reported in
   * `ClashResult.settings.tolerance`. It bounds {@link boxDistance}: for two
   * equally-sized boxes that is exactly the distance between their centres, and
   * a difference in size adds to it. Default 10 mm.
   */
  positionTolerance?: number;
  /** Distance (m) at/below which a same-shape pair is treated as an EXACT
   *  duplicate (severity `major`) rather than a candidate overlap (`minor`).
   *  Default 1 mm. */
  exactTolerance?: number;
  /**
   * @deprecated Superseded by {@link positionTolerance}. Minimum AABB
   * intersection-over-union for a pair to count as overlapping. IoU is a ratio,
   * so it imposed no fixed physical tolerance: for two equal boxes offset by `d`
   * along an axis of extent `e` the IoU is `(e − d) / (e + d)`, and the default
   * 0.9 therefore allowed `d ≤ e / 19` — 5 mm across a DN100 pipe but 421 mm
   * across an 8 m slab, from one setting. Passing this (or `exactThreshold`)
   * restores the pre-1.7 IoU **matching gate** — which pairs are reported, and
   * the old `settings.tolerance` reading — rather than silently reinterpreting
   * a number that means nothing in the new metric. It does NOT restore the
   * whole pre-1.7 behaviour: severity is still decided by the area+volume
   * shape signature (not the old triangle count), and self-pair identity is
   * still `(model, ref)` (not key-based), so a file with duplicated GlobalIds
   * reports pairs the old code hid.
   */
  // TODO(remove-by: the next major (2.0.0) — the legacy IoU branch and the
  // iouThreshold/exactThreshold members exist only for external callers of the
  // published 1.x API; no in-repo caller passes them.)
  iouThreshold?: number;
  /** @deprecated Only meaningful in the legacy IoU mode selected by
   *  {@link iouThreshold}; use {@link exactTolerance}. */
  exactThreshold?: number;
  /** Pairs whose element keys are in here are skipped (voids/hosts/assemblies). */
  exclusions?: ExclusionSet;
}

const DEFAULTS = {
  positionTolerance: 0.01,
  exactTolerance: 0.001,
  /** Legacy IoU mode only. */
  iouThreshold: 0.9,
  /** Legacy IoU mode only. */
  exactThreshold: 0.99,
} as const satisfies Required<Omit<DuplicateOptions, 'exclusions'>>;

export const DUPLICATES_RULE: ClashRule = {
  id: 'duplicates',
  name: 'Duplicate / overlapping',
  a: '*',
  mode: 'hard',
};

function toRef(el: ClashElement): ClashElementRef {
  return { key: el.key, ref: el.ref, model: el.model, tag: el.tag, name: el.name };
}

function buildSummary(clashes: Clash[]): ClashSummary {
  const byRule: Record<string, number> = {};
  const byTypePair: Record<string, number> = {};
  const bySeverity: Record<ClashSeverity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const c of clashes) {
    byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
    const pair = [c.a.tag, c.b.tag].sort().join(' vs ');
    byTypePair[pair] = (byTypePair[pair] ?? 0) + 1;
    bySeverity[c.severity] += 1;
  }
  return { total: clashes.length, byRule, byTypePair, bySeverity };
}

/**
 * Find duplicate / fully-overlapping elements. Returns a {@link ClashResult}
 * where each clash is a near-coincident pair. `settings.tolerance` is
 * `positionTolerance`, the value that actually decided the matches.
 *
 * Severity says exactly this much:
 * - `major` — some pair of the two elements' boxes coincides within
 *   `exactTolerance` **and** the two elements' meshes — summed over the
 *   several parts a multi-material / CSG element emits — agree to within 5% on
 *   both surface area and enclosed volume. Read it as "the same object, in the
 *   same place"; it survives one copy being re-tessellated, and it does not
 *   depend on which of a multi-part element's part pairings the sweep visited
 *   first.
 * - `minor` — near-coincident, but something differs: the boxes are further
 *   apart than `exactTolerance`, the shapes disagree, or one element carries no
 *   measurable geometry.
 *
 * What `major` still cannot tell you: the signature is two scalars over the
 * surface, so two genuinely different solids that happen to agree in both area
 * and volume to within 5% are indistinguishable here, as are an element and its
 * mirror image.
 *
 * ## The nested-solids limit
 *
 * Matching remains AABB-only, so an element nested inside another — a pipe in a
 * sleeve, a duct in a shaft, an assembly and the envelope drawn round it — is,
 * in principle, something this pass cannot tell from a duplicate. Two gates
 * already narrow that to a documented residual, and `duplicates.test.ts` pins
 * each case:
 *
 * - Nesting has clearance, and {@link boxDistance} measures clearance. Anything
 *   looser than ~7 mm of annulus is more than `positionTolerance` away and is
 *   never reported at all: a DN100 pipe in a DN125 sleeve is 17.7 mm away, a
 *   400×300 duct in a 500×400 shaft is 70.7 mm.
 * - Tighter nesting *is* reported, but only ever as `minor`. Reaching `major`
 *   additionally requires the two meshes to agree on surface area and enclosed
 *   volume within 5%, which distinct solids sharing a box do not: a 50 mm and a
 *   55 mm tube are 9.1% / 17.4% apart, a railing and its envelope box 73.2% /
 *   88.4%.
 *
 * So the residual is exactly this: a pair nested within a few millimetres is
 * listed as a `minor` candidate overlap. That is the intended reading of
 * `minor` — "these two coincide, and this pass will not claim they are the same
 * object" — and a reviewer still sees it, which for a coincidence hunt is the
 * safe direction.
 *
 * Measured across five public models (duplex, AC20-FZK-Haus, Office_A_20110811,
 * dental_clinic, Infra-Bridge), *no* reported pair was a nested one: all 33
 * findings are same-type pairs of equal bounds, and the count of nested or
 * cross-type pairs stays 0 even at a 250 mm tolerance, 25× the default. Note
 * what that does not cover — none of the five carries pipe or duct segments, so
 * the pipe-in-sleeve case is evidenced only by the constructed fixtures above.
 *
 * Closing the residual would need a narrow phase, which this pass deliberately
 * does not run, and the cheap substitutes are worse rather than merely weaker.
 * An area-weighted centroid plus surface inertia — the obvious candidate, and
 * the same O(triangles) cost as the signature (3.6 ms vs 2.6 ms over
 * dental_clinic's 236,795 triangles) — discriminates *less* on every nested
 * case measured, contributes nothing at all when the nesting is concentric
 * (identical centroids for pipe-in-sleeve and pipe-plus-insulation), and is not
 * tessellation-invariant: it reads 39.6% apart on one box against a finer
 * triangulation of the same box, which would break the exact-duplicate case
 * this signature exists to keep together. A voxel occupancy sample would
 * separate nested from coincident, but it needs a cell size — reintroducing the
 * scale-dependent knob that replacing the IoU gate removed.
 */
export function findDuplicates(elements: ClashElement[], options: DuplicateOptions = {}): ClashResult {
  // A caller that passes an IoU threshold is asking for IoU semantics; honour
  // them (deprecated) rather than reinterpreting the number under a metric where
  // it means nothing. Everyone else — the viewer, the CLI, every caller that
  // passes no thresholds — gets the distance gate.
  const legacyIoU = options.iouThreshold != null || options.exactThreshold != null;
  const iouThreshold = options.iouThreshold ?? DEFAULTS.iouThreshold;
  const exactThreshold = options.exactThreshold ?? DEFAULTS.exactThreshold;
  const positionTolerance = options.positionTolerance ?? DEFAULTS.positionTolerance;
  const exactTolerance = options.exactTolerance ?? DEFAULTS.exactTolerance;
  const exclusions = options.exclusions;

  const clashes: Clash[] = [];
  /** clash id → index into `clashes`, for the cross-part dedup + upgrade below. */
  const seen = new Map<string, number>();

  // Shape signatures are only needed for pairs that already coincide within
  // `exactTolerance`, and each element's is O(its triangles). Compute them
  // lazily and keep them, so a model with no coincident pairs never touches a
  // vertex and a duplicated element is measured once however many partners it
  // has.
  //
  // The signature is aggregated over ALL the meshes one element emitted (one
  // per material / CSG part, sharing `(model, ref)`): area and volume both sum
  // over parts. The exact-duplicate label is a statement about the ELEMENT
  // pair, and the several cross-part pairs of one element pair collapse to a
  // single clash id below — so comparing per-part signatures would let
  // whichever part pairing the sweep reached first decide the label. Summing
  // per-part |volume|s counts any overlap between parts twice, but it does so
  // identically on both copies, so the comparison is unaffected.
  const partsOf = new Map<string, number[]>();
  for (let i = 0; i < elements.length; i += 1) {
    const k = `${elements[i].model} ${elements[i].ref}`;
    const list = partsOf.get(k);
    if (list) list.push(i);
    else partsOf.set(k, [i]);
  }
  const signatures = new Map<string, ShapeSignature>();
  const signatureOf = (i: number): ShapeSignature => {
    const k = `${elements[i].model} ${elements[i].ref}`;
    const cached = signatures.get(k);
    if (cached) return cached;
    let area = 0;
    let volume = 0;
    for (const part of partsOf.get(k) ?? [i]) {
      const s = shapeSignature(elements[part]);
      area += s.area;
      volume += s.volume;
    }
    const computed: ShapeSignature = { area, volume };
    signatures.set(k, computed);
    return computed;
  };

  // A key repeated inside one model across *different* elements is a defect in
  // the file (`ifc-lite validate` reports duplicated GlobalIds), not proof of
  // one element — and "the same object exported twice" is exactly what a
  // duplicate hunt is for. So identity is (model, ref): `key` is the GlobalId,
  // which a broken exporter can repeat, while `ref` is the express id (or its
  // federated remap), which is unique by construction.
  //
  // A key does legitimately repeat across the several meshes one element emits
  // (one per material / CSG part) — but those share the element's `ref` too, so
  // they are still skipped as self-pairs. Only keys carried by two *distinct*
  // refs are ambiguous, and only those get the ref folded into the clash id, so
  // every id a well-formed file produced before is unchanged.
  const ambiguousKeys = new Set<string>();
  {
    const refOfKey = new Map<string, number>();
    for (const el of elements) {
      const k = `${el.model} ${el.key}`;
      const first = refOfKey.get(k);
      if (first === undefined) refOfKey.set(k, el.ref);
      else if (first !== el.ref) ambiguousKeys.add(k);
    }
  }
  const pairKey = (el: ClashElement): string => {
    const k = `${el.model} ${el.key}`;
    return ambiguousKeys.has(k) ? `${k}#${el.ref}` : k;
  };

  const consider = (i: number, j: number): void => {
    if (i >= j) return; // unordered pairs once
    const elA = elements[i];
    const elB = elements[j];
    if (elA.ref === elB.ref && elA.model === elB.model) return;
    if (
      exclusions &&
      isExcluded(exclusions, qualifiedKey(elA.model, elA.key), qualifiedKey(elB.model, elB.key))
    ) {
      return;
    }
    let exact: boolean;
    if (legacyIoU) {
      const sim = similarity(elA.bounds, elB.bounds, positionTolerance);
      if (sim < iouThreshold) return;
      exact = sim >= exactThreshold;
    } else {
      if (!boxesTouch(elA.bounds, elB.bounds)) return;
      const dist = boxDistance(elA.bounds, elB.bounds);
      if (dist > positionTolerance) return;
      exact = dist <= exactTolerance;
    }
    // Only now, on a pair that already coincides, is the shape worth measuring.
    if (exact) exact = sameShape(signatureOf(i), signatureOf(j));
    const severity: ClashSeverity = exact ? 'major' : 'minor';

    const ka = pairKey(elA);
    const kb = pairKey(elB);
    const [lo, hi] = ka < kb ? [ka, kb] : [kb, ka];
    const id = `duplicates ${lo} ${hi}`;
    const existing = seen.get(id);
    if (existing !== undefined) {
      // Multi-part elements: every cross-part pair of one element pair carries
      // this id, and which pair arrives first is an artefact of the sweep
      // order. The label must not be: if a later pair shows the copies
      // actually coincide within `exactTolerance` (the shape term is already
      // per-element), upgrade the recorded finding — and carry this pair's
      // geometry, so the record describes the coincident parts rather than
      // the loose cross pairing that happened to be swept first.
      if (severity === 'major' && clashes[existing].severity === 'minor') {
        const bounds = overlapBounds(elA.bounds, elB.bounds);
        clashes[existing] = {
          ...clashes[existing],
          severity,
          distance: -Math.max(0, minExtent(bounds)),
          point: center(bounds),
          bounds,
        };
      }
      return;
    }
    seen.set(id, clashes.length);

    const bounds = overlapBounds(elA.bounds, elB.bounds);
    clashes.push({
      id,
      a: toRef(elA),
      b: toRef(elB),
      rule: DUPLICATES_RULE.id,
      status: 'hard',
      // Coincident solids fully embed each other; report the embedded depth so
      // they read as real overlaps (not zero-distance contacts) and sort first.
      distance: -Math.max(0, minExtent(bounds)),
      point: center(bounds),
      bounds,
      severity,
    });
  };

  // Broad phase: one-axis sort-and-sweep over the AABBs. Unlike a fixed-size
  // hash grid, this makes NO assumption about element scale — so two large
  // objects offset by a few metres (still inside a metre-scale tolerance) are
  // never skipped just because many small elements shrank an average cell size.
  // Sweep along the axis with the widest spread of box minima so the active set
  // (and thus the comparison count) stays small. Eviction is exact rather than
  // conservative: it drops only boxes that no longer touch on `axis`, and a pair
  // that does not touch is rejected by the gate anyway.
  let axis = 0;
  let bestSpread = -Infinity;
  for (let a = 0; a < 3; a += 1) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const el of elements) {
      const v = el.bounds.min[a];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const spread = hi - lo;
    if (spread > bestSpread) {
      bestSpread = spread;
      axis = a;
    }
  }

  const order = elements.map((_, i) => i).sort(
    (x, y) => elements[x].bounds.min[axis] - elements[y].bounds.min[axis],
  );
  // `active` holds indices whose box still extends past the current box's start
  // on `axis`; only those can overlap, so we compare against just them.
  const active: number[] = [];
  for (const idx of order) {
    const minA = elements[idx].bounds.min[axis];
    for (let k = active.length - 1; k >= 0; k -= 1) {
      if (elements[active[k]].bounds.max[axis] < minA) {
        active[k] = active[active.length - 1];
        active.pop();
      }
    }
    for (const other of active) {
      consider(Math.min(idx, other), Math.max(idx, other));
    }
    active.push(idx);
  }

  clashes.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  return {
    clashes,
    summary: buildSummary(clashes),
    rulesRun: [DUPLICATES_RULE],
    ruleCoverage: [{ rule: DUPLICATES_RULE.id, matchedA: elements.length, matchedB: null }],
    settings: { tolerance: positionTolerance, excludeVoidsAndHosts: exclusions != null },
  };
}
