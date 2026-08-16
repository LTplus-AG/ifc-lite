/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading area / volume / weight / length off a model's own IfcElementQuantity
 * data — issue #2199 §1 (element surface area), §2 (volume) and §6 (weight).
 *
 * Pure: it takes quantity sets that somebody else already extracted and
 * decides which numbers are answerable and how they add up. Store walking,
 * occurrence-vs-type fallback and unit rendering all live at the call site.
 *
 * TWO decisions here carry the whole correctness of the feature.
 *
 * **What kind of quantity it is comes from `QuantityType`, never from the
 * name.** IFC names are open-ended — `NetSideArea`, `GrossFootprintArea`,
 * `CrossSectionArea` are all areas, and no name list will ever be complete.
 * The enum is authored by the parser off the STEP entity type
 * (`IFCQUANTITYAREA` and friends), so it cannot be wrong the way a regex can.
 *
 * **Exactly one value per (type, basis) per element.** An element commonly
 * declares several areas in one quantity set; adding them together would
 * report a wall's area as the sum of its side, footprint and cross-section.
 * So each bucket keeps a single value and the rest are dropped, with the name
 * that won recorded so the reader can see which one it was.
 */

/**
 * Whether a quantity includes or excludes openings, read off its name prefix.
 *
 * This is issue #2199 §1's "the result should indicate whether opening areas
 * are included or excluded" — IFC already encodes it, in the Gross/Net naming
 * convention, so the tool surfaces the distinction rather than inventing one.
 * `unqualified` is its own case and NOT a synonym for either: a plain `Volume`
 * makes no claim about openings, and quietly labelling it "net" would put a
 * confidence on it that the file never expressed.
 */
export type QuantityBasis = 'net' | 'gross' | 'unqualified';

/** The minimal shape this module needs from an extracted quantity set. */
export interface QuantitySetLike {
  name: string;
  quantities: ReadonlyArray<{ name: string; type: number; value: number }>;
}

/** One quantity chosen to represent a (type, basis) bucket for one element. */
export interface PickedQuantity {
  /** `QuantityType` enum value — Length 0, Area 1, Volume 2, Weight 4. */
  quantityType: number;
  basis: QuantityBasis;
  /**
   * The value, in whatever unit {@link ToSiConverter} produced — SI base when
   * one was supplied, the file's raw declared unit when it was not.
   */
  value: number;
  /** `Qto_WallBaseQuantities.NetSideArea` — which number this actually was. */
  provenance: string;
}

/**
 * Converts one raw quantity value from the file's declared unit into SI base
 * (metres, square metres, cubic metres, kilograms).
 *
 * This exists because a federation can mix units: a millimetre model and a
 * metre model both declare a `NetVolume`, and adding those numbers as they
 * stand is off by a factor of a billion. Normalising at pick time — while the
 * value is still next to the `ProjectUnits` that explain it — is the only
 * point where the file unit is still known.
 *
 * Omitting it is legitimate ONLY when every value is already SI.
 */
export type ToSiConverter = (value: number, quantityType: number) => number;

const IDENTITY_SI: ToSiConverter = (value) => value;

/**
 * `QuantityType` values this tool reports. Count and Time are deliberately
 * absent: they are not measurements of the building's geometry, and totalling
 * them beside a volume would invite reading them as one.
 */
export const MEASURABLE_QUANTITY_TYPES = {
  Length: 0,
  Area: 1,
  Volume: 2,
  Weight: 4,
} as const;

const MEASURABLE: ReadonlySet<number> = new Set(Object.values(MEASURABLE_QUANTITY_TYPES));

/**
 * Preferred names within a (type, basis) bucket, most representative first.
 *
 * This only breaks ties — a name absent from the list still competes, it just
 * loses to any listed name and to whichever unlisted name was seen first. The
 * ordering encodes "which area does a person mean by *the* area of a wall",
 * which no amount of type information can answer.
 */
const NAME_PREFERENCE: Readonly<Record<number, readonly string[]>> = {
  [MEASURABLE_QUANTITY_TYPES.Length]: ['length', 'perimeter', 'height', 'width', 'depth'],
  [MEASURABLE_QUANTITY_TYPES.Area]: [
    'area',
    'sidearea',
    'surfacearea',
    'floorarea',
    'footprintarea',
    'coveringarea',
    'crosssectionarea',
  ],
  [MEASURABLE_QUANTITY_TYPES.Volume]: ['volume'],
  [MEASURABLE_QUANTITY_TYPES.Weight]: ['weight'],
};

/**
 * Classify a quantity name as net / gross / unqualified, and return the name
 * with that prefix removed so the preference list can match on the stem.
 */
export function classifyBasis(name: string): { basis: QuantityBasis; stem: string } {
  const lower = name.toLowerCase();
  if (lower.startsWith('net')) return { basis: 'net', stem: lower.slice(3) };
  if (lower.startsWith('gross')) return { basis: 'gross', stem: lower.slice(5) };
  return { basis: 'unqualified', stem: lower };
}

/** Rank of a stem in its type's preference list; unlisted names rank last. */
function preferenceRank(quantityType: number, stem: string): number {
  const list = NAME_PREFERENCE[quantityType];
  if (!list) return Number.MAX_SAFE_INTEGER;
  const i = list.indexOf(stem);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

const bucketKey = (quantityType: number, basis: QuantityBasis) => `${quantityType}|${basis}`;

/** Row order within one quantity type: net first, then gross, then unqualified. */
const BASIS_ORDER: Readonly<Record<QuantityBasis, number>> = {
  net: 0,
  gross: 1,
  unqualified: 2,
};

/**
 * Choose at most one quantity per (type, basis) bucket for a single element.
 *
 * Non-finite values are skipped rather than carried: a `NaN` propagates
 * through every downstream sum and turns an otherwise good total for fifty
 * elements into no answer at all.
 *
 * The result is ordered by quantity type, then net / gross / unqualified, so
 * two renders of the same element never reorder their rows.
 */
export function pickElementQuantities(
  qsets: ReadonlyArray<QuantitySetLike>,
  toSi: ToSiConverter = IDENTITY_SI,
): PickedQuantity[] {
  const chosen = new Map<string, { picked: PickedQuantity; rank: number }>();

  for (const qset of qsets) {
    for (const q of qset.quantities) {
      if (!MEASURABLE.has(q.type)) continue;
      if (!Number.isFinite(q.value)) continue;

      const { basis, stem } = classifyBasis(q.name);
      const key = bucketKey(q.type, basis);
      const rank = preferenceRank(q.type, stem);
      const existing = chosen.get(key);
      // Strictly-better only, so the FIRST of two equally-ranked names wins
      // and the pick is stable under the extractor's set ordering.
      if (existing && existing.rank <= rank) continue;

      const si = toSi(q.value, q.type);
      // A converter that returns garbage must not poison the total either —
      // the finiteness check above was on the RAW value, which says nothing
      // about what came back.
      if (!Number.isFinite(si)) continue;

      chosen.set(key, {
        rank,
        picked: {
          quantityType: q.type,
          basis,
          value: si,
          provenance: `${qset.name}.${q.name}`,
        },
      });
    }
  }

  return [...chosen.values()]
    .map((c) => c.picked)
    .sort((a, b) =>
      a.quantityType - b.quantityType || BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis]);
}

/** A (type, basis) total across a selection of elements. */
export interface QuantityRollup {
  quantityType: number;
  basis: QuantityBasis;
  total: number;
  /** How many elements contributed a value. Never more than the selection. */
  contributing: number;
  /**
   * Distinct `Qset.Name` strings summed into this total, sorted. More than one
   * means the selection was heterogeneous — a total mixing `NetSideArea` and
   * `NetFloorArea` is still arithmetic, but the reader deserves to know.
   */
  provenance: string[];
}

/**
 * Total each (type, basis) bucket across a selection.
 *
 * Takes one already-picked list PER ELEMENT rather than a flat list, because
 * the no-double-counting guarantee is per element: flattening first would let
 * one element's two area names both land in the same bucket again.
 */
export function rollupQuantities(
  perElement: ReadonlyArray<ReadonlyArray<PickedQuantity>>,
): QuantityRollup[] {
  const buckets = new Map<string, QuantityRollup & { names: Set<string> }>();

  for (const element of perElement) {
    for (const picked of element) {
      const key = bucketKey(picked.quantityType, picked.basis);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          quantityType: picked.quantityType,
          basis: picked.basis,
          total: 0,
          contributing: 0,
          provenance: [],
          names: new Set<string>(),
        };
        buckets.set(key, bucket);
      }
      bucket.total += picked.value;
      bucket.contributing += 1;
      bucket.names.add(picked.provenance);
    }
  }

  return [...buckets.values()]
    .map(({ names, ...rest }) => ({ ...rest, provenance: [...names].sort() }))
    .sort((a, b) =>
      a.quantityType - b.quantityType || BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis]);
}

/**
 * Total of the kernel's proved geometry volumes across a selection.
 *
 * `MeshData.geometryVolume` is present only where the mesh pass could PROVE a
 * single closed orientable solid, and absent otherwise — never zero. That
 * absence is the answer issue #2199 §2 asks for ("report that the volume
 * cannot be calculated reliably instead of returning an incorrect result"), so
 * it is counted and reported rather than skipped silently.
 *
 * Callers must pass ONE entry per element. Every submesh of an entity carries
 * the same whole-entity volume, so passing submeshes would multiply the total
 * by the element's part count.
 */
export interface GeometryVolumeRollup {
  /** Sum over the elements whose volume was proved. */
  total: number;
  /** Elements with a proved volume. */
  proved: number;
  /** Elements whose geometry the kernel could not prove a volume for. */
  unproved: number;
}

/**
 * Total triangulated mesh surface area across a selection — issue #2199 §1
 * ("mesh analysis reachable from TypeScript") and the "Building now" §1 row
 * for element surface area, extended to the mesh-derived case a declared
 * `IfcElementQuantity` cannot answer.
 *
 * Unlike {@link rollupGeometryVolumes}, this is NOT gated on the kernel having
 * proved a single closed orientable solid: summing triangle areas needs no
 * such proof, so it is available for open shells, multi-item assemblies and
 * layered walls too — cases where `MeshData.geometryVolume` is absent. An
 * element is only "no mesh" when it has no triangulated geometry to sum at
 * all (e.g. it survives only as a GPU-instanced template with no flat mesh
 * materialised, or the selection includes a non-geometric entity).
 *
 * It is also the TOTAL triangulated surface (every face of what was meshed),
 * not one side — a different claim from `NetSideArea`/`GrossSideArea` and not
 * comparable to either. Callers must label it "mesh", matching the "mesh"
 * volume convention (`net` / `gross` / `unqualified` / `mesh`, #2199).
 */
export interface MeshAreaRollup {
  /** Sum over the elements that had mesh geometry to measure. */
  total: number;
  /** Elements a triangulated area was computed for. */
  withMesh: number;
  /** Elements with no triangulated geometry to sum (no mesh loaded). */
  withoutMesh: number;
}

export function rollupMeshArea(
  perElement: ReadonlyArray<number | undefined>,
): MeshAreaRollup {
  let total = 0;
  let withMesh = 0;
  let withoutMesh = 0;
  for (const v of perElement) {
    if (v === undefined || !Number.isFinite(v)) {
      withoutMesh += 1;
      continue;
    }
    total += v;
    withMesh += 1;
  }
  return { total, withMesh, withoutMesh };
}

export function rollupGeometryVolumes(
  perElement: ReadonlyArray<number | undefined>,
): GeometryVolumeRollup {
  let total = 0;
  let proved = 0;
  let unproved = 0;
  for (const v of perElement) {
    // `undefined` means unproved; a non-finite number would poison the sum, so
    // it is treated as unproved too rather than trusted for being a number.
    if (v === undefined || !Number.isFinite(v)) {
      unproved += 1;
      continue;
    }
    total += v;
    proved += 1;
  }
  return { total, proved, unproved };
}
