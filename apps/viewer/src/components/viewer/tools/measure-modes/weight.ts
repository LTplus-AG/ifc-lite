/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Weight with its provenance attached — issue #2736 (split from #2199 §6).
 *
 * `quantities.ts` already reports a weight the file DECLARES. This module adds
 * the other two ways a weight can be known, and — the whole point — keeps them
 * apart:
 *
 * - `declared` — an `IfcQuantityWeight` the file authored. Measured.
 * - `derived-ifc-density` — geometry volume x a density the FILE declared
 *   (`Pset_MaterialCommon.MassDensity`). Calculated from two things the file
 *   said, but the multiplication is ours.
 * - `derived-library-density` — geometry volume x a density the file never
 *   said, supplied by a user or project density library. An estimate.
 *
 * These are three different confidence levels and this module refuses to
 * collapse them, for the same reason `QuantityBasis` refuses to read a bare
 * `Volume` as "net": labelling an estimate "Weight" asserts a measurement the
 * file never made. {@link rollupWeights} therefore totals each basis into its
 * own row rather than summing them, so a selection where half the elements
 * declare a weight and half are estimated can never render as one number.
 *
 * Three refusals are load-bearing and are why this is a module rather than
 * three lines at the call site:
 *
 * **A declared weight is never derived over.** {@link resolveElementWeight}
 * returns the declared value the moment there is one, before it even looks at
 * volume or density. A derivation that "improved on" a declared quantity would
 * replace what the file says with what we computed, which is the opposite of
 * what this panel is for.
 *
 * **An untrusted volume never becomes a confident mass.** The geometry volume
 * is only usable when the caller vouches for it (`volumeTrusted`) — federation
 * alignment can re-bake a model's vertices, leaving a proved volume that
 * describes a size no longer on screen (#1993,
 * `geometryVolumesSurviveAlignment`). Multiplying that by a density would turn
 * "we scaled it away" into a mass with four significant figures. No result at
 * all is the better answer, and the reason is returned rather than swallowed so
 * the readout can say it.
 *
 * **Two materials disagreeing about density is not an average.** A layered
 * wall's mass is the sum of each layer's volume times its own density, and
 * nothing here knows the layer volumes. Picking one of the densities, or the
 * mean of them, would answer a question we cannot answer — so
 * {@link pickIfcDensity} reports the conflict instead (`density-ambiguous`).
 */

/** Where a weight came from, in descending order of what the file vouches for. */
export type WeightBasis = 'declared' | 'derived-ifc-density' | 'derived-library-density';

/**
 * Whether the file's weight convention is a mass or a force — issue #2736 §4.
 *
 * `QuantityType.Weight` resolves through `project_units`' `MASSUNIT`
 * (`QUANTITY_TYPE_UNIT` in `lib/units/display.ts`), which is the canonical
 * source and the only one this feature uses. A file whose `MASSUNIT` resolves
 * to a force symbol (an exporter writing `.NEWTON.` under `MASSUNIT`) has said
 * something self-contradictory, and `'force'` records that rather than papering
 * over it — see {@link resolveElementWeight}, which then declines to derive
 * rather than guessing whether the reader wanted kilograms or kilonewtons.
 */
export type WeightUnitKind = 'mass' | 'force';

/** A density already normalised to SI kg/m³, and what supplied it. */
export interface DensityPick {
  /** kg/m³. */
  density: number;
  /** Which of the two derived bases this density earns. */
  basis: Exclude<WeightBasis, 'declared'>;
  /** `Concrete C30/37 · Pset_MaterialCommon.MassDensity` — readable, not parsed. */
  provenance: string;
}

/** Why a density could not be settled on. Both are things the readout can say. */
export type NoDensityReason =
  /** Nothing offered a density for this element at all. */
  | 'no-density'
  /** Its materials declared densities that disagree, with no way to apportion. */
  | 'density-ambiguous';

export type DensityResult =
  | { kind: 'density'; pick: DensityPick }
  | { kind: 'none'; reason: NoDensityReason };

/** Everything known about one element's weight, before deciding. */
export interface ElementWeightInput {
  /**
   * The file's own weight quantity, already SI (kg), if it declared one.
   * Present means DONE: nothing below is consulted.
   */
  declared?: { value: number; provenance: string };
  /** Geometry volume in SI m³; `undefined` when the kernel proved none. */
  volume?: number;
  /**
   * Whether that volume still describes the geometry on screen. `false` for a
   * model federation alignment re-baked — the volume exists and is wrong.
   */
  volumeTrusted: boolean;
  /** The density to multiply by, or the reason there is none. */
  density?: DensityResult;
  /** The file's weight convention. Defaults to `'mass'`, the IFC meaning. */
  unitKind?: WeightUnitKind;
}

/** One element's answer, with the confidence level it was reached at. */
export interface ElementWeight {
  basis: WeightBasis;
  /**
   * Kilograms. Declared weights arrive already converted from the file's
   * `MASSUNIT`; derived ones are kg/m³ x m³, which is kg by construction.
   */
  value: number;
  provenance: string;
}

/** Why no weight could be given. Each one is something the readout can say. */
export type NoWeightReason =
  /** The kernel proved no enclosed volume for this element. */
  | 'no-volume'
  /** A volume exists but federation alignment invalidated it (#1993). */
  | 'volume-untrusted'
  /** The file's MASSUNIT resolves to a force; mass vs force is unanswerable. */
  | 'weight-unit-is-force'
  | NoDensityReason;

export type WeightOutcome =
  | { kind: 'weight'; weight: ElementWeight }
  | { kind: 'none'; reason: NoWeightReason };

/**
 * Decide one element's weight and how much to trust it.
 *
 * The order of the guards IS the specification, so read it as one: declared
 * wins outright; a force convention stops the derivation before it starts; an
 * untrusted volume is refused SEPARATELY from a missing one (they are
 * different facts and the readout distinguishes them); and a non-positive or
 * non-finite density counts as no density at all, because a zero-kilogram mass
 * presented as an answer is worse than no answer.
 */
export function resolveElementWeight(input: ElementWeightInput): WeightOutcome {
  const { declared, volume, volumeTrusted, density } = input;

  // Declared first, and unconditionally. Everything after this line is a
  // calculation; the file's own number is not something to improve on.
  if (declared && Number.isFinite(declared.value)) {
    return {
      kind: 'weight',
      weight: { basis: 'declared', value: declared.value, provenance: declared.provenance },
    };
  }

  // A derivation produces kilograms — kg/m³ x m³ — and cannot be relabelled
  // into the newtons this file's own convention implies without inventing a
  // gravity constant the unit system does not have. So it declines.
  if ((input.unitKind ?? 'mass') === 'force') {
    return { kind: 'none', reason: 'weight-unit-is-force' };
  }

  if (volume === undefined || !Number.isFinite(volume)) {
    return { kind: 'none', reason: 'no-volume' };
  }
  if (!volumeTrusted) {
    return { kind: 'none', reason: 'volume-untrusted' };
  }
  if (!density) return { kind: 'none', reason: 'no-density' };
  if (density.kind === 'none') return { kind: 'none', reason: density.reason };

  const { pick } = density;
  if (!Number.isFinite(pick.density) || pick.density <= 0) {
    return { kind: 'none', reason: 'no-density' };
  }

  const value = volume * pick.density;
  // Both inputs were finite and the density positive, so this is finite unless
  // the multiplication overflowed to Infinity — which is not a mass.
  if (!Number.isFinite(value)) return { kind: 'none', reason: 'no-density' };

  return {
    kind: 'weight',
    weight: { basis: pick.basis, value, provenance: pick.provenance },
  };
}

/** A per-basis weight total across a selection. */
export interface WeightRollup {
  basis: WeightBasis;
  /** Kilograms, summed only within this basis. */
  total: number;
  /** How many elements contributed. Never more than the selection. */
  contributing: number;
  /** Distinct source strings summed into this total, sorted. */
  provenance: string[];
}

/** Rows are ordered by descending confidence, so the readout never reorders. */
const BASIS_ORDER: Readonly<Record<WeightBasis, number>> = {
  declared: 0,
  'derived-ifc-density': 1,
  'derived-library-density': 2,
};

/** The counts a readout needs in order to explain what it is NOT showing. */
export type NoWeightCounts = Readonly<Record<NoWeightReason, number>>;

export interface WeightSummary {
  rows: WeightRollup[];
  /** Elements that produced no weight, by reason. Every element is accounted for. */
  withheld: NoWeightCounts;
}

/**
 * Total each basis across a selection, keeping the bases apart.
 *
 * Summing a declared weight into a library-density estimate would produce a
 * number that is neither, and there is no honest label for it — so each basis
 * gets its own row and the reader adds them up only if they decide to.
 */
export function rollupWeights(perElement: ReadonlyArray<WeightOutcome>): WeightSummary {
  const buckets = new Map<WeightBasis, WeightRollup & { names: Set<string> }>();
  const withheld: Record<NoWeightReason, number> = {
    'no-volume': 0,
    'volume-untrusted': 0,
    'no-density': 0,
    'density-ambiguous': 0,
    'weight-unit-is-force': 0,
  };

  for (const outcome of perElement) {
    if (outcome.kind === 'none') {
      withheld[outcome.reason] += 1;
      continue;
    }
    const { basis, value, provenance } = outcome.weight;
    let bucket = buckets.get(basis);
    if (!bucket) {
      bucket = { basis, total: 0, contributing: 0, provenance: [], names: new Set<string>() };
      buckets.set(basis, bucket);
    }
    bucket.total += value;
    bucket.contributing += 1;
    bucket.names.add(provenance);
  }

  const rows = [...buckets.values()]
    .map(({ names, ...rest }) => ({ ...rest, provenance: [...names].sort() }))
    .sort((a, b) => BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis]);

  return { rows, withheld };
}

/**
 * Symbols that mean a force, for a `MASSUNIT` that resolved to one of them.
 *
 * Deliberately about the SYMBOL rather than the IFC unit enum: the enum
 * already says `MASSUNIT`, and the reason we look twice is that some exporters
 * write a force unit under it. The first three come from `alternatives.ts`'s
 * `FORCEUNIT` family; `kip` comes from `conversionUnitSymbol` in the parser's
 * unit resolver.
 */
const FORCE_SYMBOLS: ReadonlySet<string> = new Set(['N', 'kN', 'MN', 'lbf', 'kip']);

/**
 * Classify the file's weight convention from the symbol `MASSUNIT` resolved to.
 *
 * `undefined` — the file declared no `MASSUNIT` — is `'mass'`, not a third
 * "unknown" state: `QUANTITY_TYPE_UNIT` already defaults `QuantityType.Weight`
 * to kilograms and that default is what the panel renders today. Answering
 * "unknown" here would suppress the derivation for the overwhelmingly common
 * file that declares no units at all, which is not an ambiguity — IFC's own
 * meaning for `IfcQuantityWeight` is a mass.
 */
export function classifyWeightUnitKind(massUnitSymbol: string | undefined): WeightUnitKind {
  if (massUnitSymbol && FORCE_SYMBOLS.has(massUnitSymbol.trim())) return 'force';
  return 'mass';
}

/** The minimal shape this module needs from `extractMaterialPropertiesOnDemand`. */
export interface MaterialPsetGroupLike {
  materialName: string;
  psets: ReadonlyArray<{
    name: string;
    properties: ReadonlyArray<{ name: string; value: unknown }>;
  }>;
}

/** The pset and property IFC standardises a material's density under. */
const DENSITY_PSET = 'pset_materialcommon';
const DENSITY_PROPERTY = 'massdensity';

/**
 * Relative tolerance for calling two materials' densities "the same number".
 *
 * Two materials CAN legitimately carry the same density written slightly
 * differently (2400 vs 2400.0000001 after a unit round trip). Anything wider
 * than a float-noise band would start averaging genuinely different materials,
 * which is the thing {@link pickIfcDensity} exists to refuse.
 */
const DENSITY_AGREEMENT_TOLERANCE = 1e-9;

/**
 * Read one SI density off an element's material property sets.
 *
 * `toSi` converts the file's declared `MASSDENSITYUNIT` into kg/m³ and is the
 * caller's job for the same reason it is in `pickElementQuantities`: the file
 * unit is only knowable next to the `ProjectUnits` that declared it.
 *
 * Returns `density-ambiguous` — NOT a density — when the element's materials
 * declare more than one distinct value. Deriving a mass then would need each
 * material's share of the volume, which this panel does not have; a layered
 * wall is not its heaviest layer and is not the average of its layers either.
 */
export function pickIfcDensity(
  groups: ReadonlyArray<MaterialPsetGroupLike>,
  toSi: (value: number) => number = (v) => v,
): DensityResult {
  let chosen: { density: number; provenance: string } | undefined;

  for (const group of groups) {
    for (const pset of group.psets) {
      if (pset.name.trim().toLowerCase() !== DENSITY_PSET) continue;
      for (const property of pset.properties) {
        if (property.name.trim().toLowerCase() !== DENSITY_PROPERTY) continue;
        // Only an actual number counts. A string "2400" is a value some
        // exporter did not type, and coercing it would make the tool's
        // confidence depend on a `Number()` call rather than on the schema.
        if (typeof property.value !== 'number' || !Number.isFinite(property.value)) continue;

        const density = toSi(property.value);
        // A converter that returned garbage must not become a mass either —
        // the check above was on the RAW value, which says nothing about this.
        if (!Number.isFinite(density) || density <= 0) continue;

        const provenance = `${group.materialName} · ${pset.name}.${property.name}`;
        if (!chosen) {
          chosen = { density, provenance };
          continue;
        }
        const spread = Math.abs(density - chosen.density);
        if (spread > DENSITY_AGREEMENT_TOLERANCE * Math.max(density, chosen.density)) {
          return { kind: 'none', reason: 'density-ambiguous' };
        }
      }
    }
  }

  if (!chosen) return { kind: 'none', reason: 'no-density' };
  return {
    kind: 'density',
    pick: { density: chosen.density, basis: 'derived-ifc-density', provenance: chosen.provenance },
  };
}
