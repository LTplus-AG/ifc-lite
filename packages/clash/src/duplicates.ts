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
 * signature is computed lazily, only for pairs that already coincide.
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

import type { AABB } from '@ifc-lite/spatial';
import { center, overlapBounds } from './math/aabb.js';
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
   * restores the whole pre-1.7 IoU behaviour for that call rather than silently
   * reinterpreting a number that means nothing in the new metric.
   */
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

function aabbVolume(b: AABB): number {
  const dx = Math.max(0, b.max[0] - b.min[0]);
  const dy = Math.max(0, b.max[1] - b.min[1]);
  const dz = Math.max(0, b.max[2] - b.min[2]);
  return dx * dy * dz;
}

/** Intersection-over-union of two AABBs (0 when disjoint). */
function aabbIoU(a: AABB, b: AABB): number {
  const ox = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const oy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  const oz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
  if (ox <= 0 || oy <= 0 || oz <= 0) return 0;
  const inter = ox * oy * oz;
  const union = aabbVolume(a) + aabbVolume(b) - inter;
  return union > 0 ? inter / union : 0;
}

function aabbApproxEqual(a: AABB, b: AABB, tol: number): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(a.min[i] - b.min[i]) > tol) return false;
    if (Math.abs(a.max[i] - b.max[i]) > tol) return false;
  }
  return true;
}

/**
 * Distance (m) between two boxes as *objects*: the largest distance any corner
 * of `a` has to travel to reach the matching corner of `b`. Because the max over
 * the eight corners picks, independently per axis, whichever face moved further,
 * it reduces to the Euclidean norm of the three per-axis face offsets — one
 * square root, no corner enumeration.
 *
 * Two properties make it the tolerance a user can reason about:
 * - **Pure translation gives exactly the translation length.** Every corner
 *   moves by `d`, so the result is `|d|`, whatever the shape and whatever the
 *   direction. That is what makes it isotropic, where IoU was not.
 * - **A size difference counts too.** Concentric boxes whose faces differ by δ
 *   are δ apart, so this is centre distance *and* a shape check in one number,
 *   with no second, dimensionless knob.
 *
 * It is still AABB-only. Two elements with the same bounds and different solids
 * inside them (a duct inside a shaft; a nested assembly) are indistinguishable
 * here — separating those needs a narrow phase this pass deliberately does not
 * run.
 */
function boxDistance(a: AABB, b: AABB): number {
  let sum = 0;
  for (let i = 0; i < 3; i += 1) {
    const d = Math.max(Math.abs(a.min[i] - b.min[i]), Math.abs(a.max[i] - b.max[i]));
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Do the boxes touch or overlap on every axis? Two elements that are disjoint
 *  in space are two objects, however close. Without this an element SMALLER than
 *  the tolerance (a 5 mm fixing at a 10 mm tolerance) would pair with a
 *  neighbour it never intersects. Touching (zero gap) counts, so coincident
 *  planar and point geometry still qualifies. */
function boxesTouch(a: AABB, b: AABB): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (Math.min(a.max[i], b.max[i]) < Math.max(a.min[i], b.min[i])) return false;
  }
  return true;
}

/** Legacy IoU similarity in `[0,1]`, falling back to box-equality for degenerate
 *  (zero-volume / planar) elements where IoU is undefined. */
function similarity(a: AABB, b: AABB, tol: number): number {
  const iou = aabbIoU(a, b);
  if (iou > 0) return iou;
  // Both (near) degenerate: an exact box match still means "same place".
  if (aabbVolume(a) <= 0 || aabbVolume(b) <= 0) {
    return aabbApproxEqual(a, b, tol) ? 1 : 0;
  }
  return 0;
}

/** Shortest dimension of a box — the depth one element is embedded in another. */
function minExtent(b: AABB): number {
  return Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}

/**
 * How far apart (relative) two elements' surface areas / enclosed volumes may be
 * and still count as the same shape. 5% is chosen from the two failure modes it
 * has to separate, both measured on the fixtures in `duplicates.test.ts`:
 * - **Same solid, re-tessellated.** A flat-faced solid — the box that started
 *   this — is *exactly* invariant: a 12- and a 48-triangle 1×1×3 box both give
 *   area 14 and volume 3. A faceted curved solid is not, because each
 *   refinement encloses more: a 12- vs a 36-segment column differs by 4.0% in
 *   volume. 5% keeps that pair together.
 * - **Different solids sharing a bounding box.** A round column and a square
 *   column of the same bounds differ by 22.7% in area and 25.0% in volume —
 *   ~5× the tolerance.
 * Below ~8 segments the two modes genuinely overlap (an 8- vs 36-segment
 * column is 9.5% apart) and no threshold separates them; such a pair reads as
 * `minor`, which is the safe direction: it is still reported, just not labelled
 * exact.
 */
const SHAPE_REL_TOL = 0.05;

/** Total surface area (m²) and enclosed volume (m³) of one element's mesh. */
interface ShapeSignature {
  area: number;
  volume: number;
}

/**
 * A tessellation-invariant fingerprint of an element's world-space triangle
 * soup. Both numbers are integrals over the *surface*, so re-triangulating the
 * same surface leaves them unchanged — which the triangle count this replaced
 * did not: a 12- and a 48-triangle box are the same object and read as
 * different, while a round and a square column of equal bounds can share a
 * count and read as the same.
 *
 * Volume is `|Σ v0 · (v1 × v2)| / 6` (the divergence theorem). It is exact for
 * a closed, consistently wound mesh and 0 for a flat sheet; an inconsistently
 * wound mesh yields some other tessellation-dependent number, which can only
 * ever *demote* a pair to `minor` (the conservative direction). Area is
 * invariant regardless of winding, so the pair of numbers degrades gracefully.
 * The absolute value makes a wholly reversed mesh — the same solid, wound
 * inward — match the mesh it copies.
 *
 * O(triangles), and computed at most once per element (see `signatureOf`), only
 * for elements that already reached the exact-duplicate gate — so a model with
 * no coincident pairs pays nothing for it.
 */
function shapeSignature(el: ClashElement): ShapeSignature {
  const { positions, indices } = el;
  const m = el.transform;
  const vertexCount = Math.floor(positions.length / 3);
  const triangles = Math.floor(indices.length / 3);
  // Three world-space vertices, held flat to keep the loop allocation-free.
  const v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let area = 0;
  let volume = 0;
  for (let t = 0; t < triangles; t += 1) {
    let ok = true;
    for (let k = 0; k < 3; k += 1) {
      const vi = indices[t * 3 + k];
      if (vi >= vertexCount) {
        // An out-of-range index has no position to read; skipping the triangle
        // keeps the signature finite instead of poisoning it with NaN.
        ok = false;
        break;
      }
      const o = vi * 3;
      const x = positions[o];
      const y = positions[o + 1];
      const z = positions[o + 2];
      if (m) {
        // f32-round the transformed coords exactly as `TriMesh.vertex` does, so
        // a signature never disagrees with the narrow phase about where a
        // vertex is.
        v[k * 3] = Math.fround(m[0] * x + m[4] * y + m[8] * z + m[12]);
        v[k * 3 + 1] = Math.fround(m[1] * x + m[5] * y + m[9] * z + m[13]);
        v[k * 3 + 2] = Math.fround(m[2] * x + m[6] * y + m[10] * z + m[14]);
      } else {
        v[k * 3] = x;
        v[k * 3 + 1] = y;
        v[k * 3 + 2] = z;
      }
    }
    if (!ok) continue;
    const e1x = v[3] - v[0];
    const e1y = v[4] - v[1];
    const e1z = v[5] - v[2];
    const e2x = v[6] - v[0];
    const e2y = v[7] - v[1];
    const e2z = v[8] - v[2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    volume += (v[0] * (v[4] * v[8] - v[5] * v[7])
      - v[1] * (v[3] * v[8] - v[5] * v[6])
      + v[2] * (v[3] * v[7] - v[4] * v[6])) / 6;
  }
  return { area, volume: Math.abs(volume) };
}

/** Relative agreement, with 0 vs 0 counting as agreement (a flat sheet has no
 *  volume, so such a pair is decided on area alone). */
function relClose(x: number, y: number): boolean {
  const scale = Math.max(Math.abs(x), Math.abs(y));
  return Math.abs(x - y) <= SHAPE_REL_TOL * scale;
}

/** Do the two meshes describe the same solid? An element with no measurable
 *  surface (no triangles, or geometry the caller did not supply) carries no
 *  evidence either way, so it is never promoted to "exact". */
function sameShape(a: ShapeSignature, b: ShapeSignature): boolean {
  if (a.area <= 0 || b.area <= 0) return false;
  return relClose(a.area, b.area) && relClose(a.volume, b.volume);
}

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
 * - `major` — the two boxes coincide within `exactTolerance` **and** the two
 *   meshes agree to within 5% on both surface area and enclosed volume. Read
 *   it as "the same object, in the same place", and it survives one copy being
 *   re-tessellated.
 * - `minor` — near-coincident, but something differs: the boxes are further
 *   apart than `exactTolerance`, the shapes disagree, or one element carries no
 *   measurable geometry.
 *
 * What `major` still cannot tell you: the signature is two scalars over the
 * surface, so two genuinely different solids that happen to agree in both area
 * and volume to within 5% are indistinguishable here, as are an element and its
 * mirror image. And the pass remains AABB-only for *matching*: a duct inside a
 * shaft that shares its bounds is still reported as a candidate pair (`minor`),
 * because separating nested from coincident needs a narrow phase this pass
 * deliberately does not run.
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
  const seen = new Set<string>();

  // Shape signatures are only needed for pairs that already coincide within
  // `exactTolerance`, and each element's is O(its triangles). Compute them
  // lazily and keep them, so a model with no coincident pairs never touches a
  // vertex and a duplicated element is measured once however many partners it
  // has.
  const signatures: (ShapeSignature | undefined)[] = new Array(elements.length);
  const signatureOf = (i: number): ShapeSignature => {
    const cached = signatures[i];
    if (cached) return cached;
    const computed = shapeSignature(elements[i]);
    signatures[i] = computed;
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
    if (seen.has(id)) return;
    seen.add(id);

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
    settings: { tolerance: positionTolerance, excludeVoidsAndHosts: exclusions != null },
  };
}
