/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WHICH volume an apportionment apportions (issue #2508 design questions 2 and
 * 3), following the convention #2199 settled: the tool never decides, it
 * labels.
 *
 * A zone volume derived from a wall's NET volume and one derived from its GROSS
 * volume are not comparable, and neither is a number carrying no label at all.
 * So a share is never a bare cubic metre count — it is a cubic metre count on a
 * NAMED basis, and the name travels with it to the UI.
 *
 * ## The four bases
 *
 * - `mesh` — the kernel's enclosed volume of the geometry as built, i.e. AFTER
 *   opening cuts. The only basis whose per-zone split is measured rather than
 *   inferred, and the only one that exists for every provably-solid element.
 * - `net` — a declared `Net*Volume` quantity: openings excluded.
 * - `gross` — a declared `Gross*Volume` quantity: openings included.
 * - `unqualified` — a declared plain `Volume`: the file makes NO claim about
 *   openings. Not a synonym for net. Measured on
 *   `01_BIMcollab_Example_ARC.ifc`, the declared `net` volume matches the
 *   as-built mesh for 300 of 300 elements within 1% (291 within 0.1%), while
 *   `unqualified` disagrees with it by a median 11.7% and `gross` by up to
 *   300%. Collapsing the three would put a confidence on a number the file
 *   never expressed.
 *
 * ## Answering #2508's question 2
 *
 * "Reconcile with the declared QTO, or report computed volumes?" — both, kept
 * apart. The geometric FRACTIONS come from the mesh (there is nothing else to
 * measure them on); the MAGNITUDE comes from whichever basis is being shown. So
 * a `net` breakdown sums to the declared `NetVolume` by construction and cannot
 * read as a bug against the number the user already trusts, while the `mesh`
 * breakdown stays self-consistent with the geometry on screen. Both are
 * offered, each labelled.
 *
 * ## Answering #2508's question 3
 *
 * "Openings — subtracted before apportioning?" — the SPLIT is always taken on
 * the as-built mesh, which has its openings cut, because that is the only
 * geometry there is. Applying that split to a `gross` magnitude is therefore an
 * approximation wherever an opening sits off-centre, and
 * {@link volumeBasisRatioNote} says so beside the numbers rather than in a
 * tooltip.
 */

/** How a volume treats openings. See the module doc. */
export type VolumeBasis = 'mesh' | 'net' | 'gross' | 'unqualified';

/** `QuantityType.Volume` from `@ifc-lite/data`, spelled out so this pure module
 *  does not drag the data package into the zones library. */
export const VOLUME_QUANTITY_TYPE = 2;

/** Rendered beside the numbers, never hidden in a tooltip (#2199's rule). */
export const VOLUME_BASIS_LEGEND =
  'net = openings excluded · gross = openings included · mesh = as built, after opening cuts · unqualified = the file makes no claim';

/** Short label for one basis, for a column header or a chip. */
export function volumeBasisLabel(basis: VolumeBasis): string {
  switch (basis) {
    case 'mesh': return 'mesh';
    case 'net': return 'net';
    case 'gross': return 'gross';
    case 'unqualified': return 'unqualified';
  }
}

/**
 * The disclosure that has to travel with any basis other than `mesh`: the split
 * ratio was measured on the as-built geometry, so applying it to a declared
 * total assumes the openings are distributed the way the mesh has them.
 */
export function volumeBasisRatioNote(basis: VolumeBasis): string | null {
  if (basis === 'mesh') return null;
  return 'Split measured on the as-built mesh, then applied to the declared total.';
}

/**
 * Classify a declared quantity by its NAME. Only the opening convention comes
 * from the name — whether the quantity is a volume at all comes from its
 * `QuantityType`, which is authored off the STEP entity type and so cannot be
 * wrong the way a name list can (#2514's rule).
 *
 * `NetVolume`, `NetSideVolume` and the IFC4 `NetVolume` on a type all read as
 * net; `GrossVolume`, `GrossFootprintVolume` as gross; everything else,
 * including a bare `Volume`, as unqualified.
 */
export function volumeBasisFromQuantityName(name: string): Exclude<VolumeBasis, 'mesh'> {
  const n = name.trim().toLowerCase();
  if (n.startsWith('net')) return 'net';
  if (n.startsWith('gross')) return 'gross';
  return 'unqualified';
}

/** The minimum a quantity has to expose for {@link declaredVolumeBases}. */
export interface QuantityLike {
  name: string;
  type: number;
  value: number;
}

/** The minimum a quantity SET has to expose. */
export interface QuantitySetLike {
  name: string;
  quantities: readonly QuantityLike[];
}

/** One declared volume an element carries, normalised to SI cubic metres. */
export interface DeclaredVolume {
  basis: Exclude<VolumeBasis, 'mesh'>;
  /** The quantity's own name, e.g. `NetVolume` — shown so a user can find it in
   *  the properties panel rather than wondering which number this was. */
  quantityName: string;
  /** Cubic metres. `volumeSiScale` has already been applied. */
  valueM3: number;
}

/**
 * Every declared volume quantity on an element, one per basis, normalised to SI.
 *
 * `volumeSiScale` is the file's own VOLUMEUNIT scale from `ProjectUnits`
 * (`resolvedForUnitType('VOLUMEUNIT').siScale`) — the canonical resolver, never
 * a hand-rolled `1e-9`. It matters: `building-architecture.ifc` declares
 * millimetre LENGTH alongside cubic-metre VOLUME, so deriving one from the
 * other is wrong by a factor of a billion.
 *
 * At most one entry per basis. Ties within a basis keep the FIRST seen in
 * quantity-set order, so a wall carrying `NetVolume` in two sets reports one
 * net figure rather than their sum.
 */
export function declaredVolumeBases(
  quantitySets: readonly QuantitySetLike[],
  volumeSiScale: number,
): DeclaredVolume[] {
  const scale = Number.isFinite(volumeSiScale) && volumeSiScale > 0 ? volumeSiScale : 1;
  const out: DeclaredVolume[] = [];
  const seen = new Set<string>();
  for (const qset of quantitySets) {
    for (const q of qset.quantities) {
      if (q.type !== VOLUME_QUANTITY_TYPE) continue;
      if (!Number.isFinite(q.value)) continue;
      const basis = volumeBasisFromQuantityName(q.name);
      if (seen.has(basis)) continue;
      seen.add(basis);
      out.push({ basis, quantityName: q.name, valueM3: q.value * scale });
    }
  }
  return out;
}

/** One zone's share of one named basis. */
export interface BasisShare {
  zoneId: string;
  zoneName: string;
  /** Cubic metres of the NAMED basis in this zone. */
  valueM3: number;
  fraction: number;
}

/** A complete per-zone breakdown on one named basis. */
export interface BasisBreakdown {
  basis: VolumeBasis;
  /** `null` for `mesh`; the declared quantity's name otherwise. */
  quantityName: string | null;
  /** The element's whole volume on this basis, cubic metres. */
  totalM3: number;
  shares: BasisShare[];
  /** Volume of the element in no zone of the set, on this basis. */
  outsideM3: number;
}

/** The apportionment fields {@link basisBreakdown} needs — a structural subset
 *  of `ElementApportionment` so this module does not depend on the clipper. */
export interface FractionSource {
  wholeVolumeM3: number;
  shares: ReadonlyArray<{ zoneId: string; zoneName: string; fraction: number }>;
  outsideFraction: number;
}

/**
 * Re-express a geometric apportionment on a named basis by scaling every
 * fraction by that basis's total.
 *
 * For `mesh` this is the identity on the numbers the clipper produced. For a
 * declared basis it reconciles with the file's own quantity by construction:
 * the shares sum to `totalM3` exactly as far as the fractions sum to 1, which
 * is the invariant `apportionment.ts` asserts.
 */
export function basisBreakdown(
  source: FractionSource,
  basis: VolumeBasis,
  totalM3: number,
  quantityName: string | null,
): BasisBreakdown {
  return {
    basis,
    quantityName,
    totalM3,
    shares: source.shares.map((s) => ({
      zoneId: s.zoneId,
      zoneName: s.zoneName,
      valueM3: s.fraction * totalM3,
      fraction: s.fraction,
    })),
    outsideM3: source.outsideFraction * totalM3,
  };
}

/**
 * Every breakdown an element can offer, `mesh` first and then each declared
 * basis in net / gross / unqualified order.
 *
 * `mesh` leads because it is the one whose split was measured rather than
 * assumed, and because it is the only basis present for every element. It is
 * NOT presented as more correct than a declared quantity — that is the user's
 * call, which is why every one of them is shown with its name.
 */
const BASIS_ORDER: ReadonlyArray<Exclude<VolumeBasis, 'mesh'>> = ['net', 'gross', 'unqualified'];

export function allBasisBreakdowns(
  source: FractionSource,
  declared: readonly DeclaredVolume[],
): BasisBreakdown[] {
  const out = [basisBreakdown(source, 'mesh', source.wholeVolumeM3, null)];
  for (const basis of BASIS_ORDER) {
    const d = declared.find((x) => x.basis === basis);
    if (d) out.push(basisBreakdown(source, basis, d.valueM3, d.quantityName));
  }
  return out;
}
