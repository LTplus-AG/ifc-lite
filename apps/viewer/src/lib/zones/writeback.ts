/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Zone assignment as IFC data (issue #2508, item 3: "get zone data out of the
 * viewer" - the pset write-back half).
 *
 * v1 and #2515 leave every zone number inside the viewer: store state, a JSON
 * side file, and columns in Lists. None of that survives handing the model to
 * someone else. This module turns one element's classification into the
 * property set and quantity set an IFC export can carry, so the assignment
 * travels with the file.
 *
 * It is PURE: it decides names, labels, units and collisions, and nothing else.
 * Gathering the facts (which elements, which apportionment, which model) is the
 * caller's job - see `hooks/useZoneWriteBack.ts`.
 *
 * ## Three rules this file exists to enforce
 *
 * 1. **Values are written in the FILE's units, not in metres.** Everything
 *    upstream of here is SI cubic metres (the render frame is metres), but an
 *    `IfcQuantityVolume` with no explicit unit is read in the project's declared
 *    VOLUMEUNIT. Writing 3.4 into a file that declares cubic millimetres states
 *    3.4 mm3. So every value divides by the model's own `volumeSiScale`, and
 *    federated models are converted with their own scale rather than the active
 *    one.
 * 2. **The basis travels with the number** (#2199's convention, adopted by
 *    `volume-basis.ts` and kept here): the quantity set NAMES the basis, and the
 *    property set repeats it along with the declared quantity it came from, so a
 *    net breakdown can never be mistaken for a gross one downstream.
 * 3. **A refusal is written down, not omitted.** An element whose volume the
 *    kernel would not prove gets its zone names and a stated reason, and no
 *    quantities at all. A missing row reads as "zero"; a stated reason does not.
 */

import type { ApportionmentRefusal } from './apportionment-cache.js';
import type { VolumeBasis } from './volume-basis.js';
import { volumeBasisLabel, volumeBasisRatioNote } from './volume-basis.js';

/**
 * Prefix for both sets this module writes.
 *
 * NOT `Pset_` / `Qto_`: buildingSMART reserves those for its own published
 * definitions, and "which takt area is this wall in" is not one of them. A
 * vendor-prefixed name says where the data came from and cannot collide with a
 * standard set a checker validates against.
 */
export const ZONE_SET_NAME_PREFIX = 'IfcLite_Zones';
export const ZONE_QUANTITY_SET_NAME_PREFIX = 'IfcLite_ZoneVolumes';

/** Property set name for one zone set, e.g. `IfcLite_Zones [Takt areas]`. */
export function zonePropertySetName(zoneSetName: string): string {
  return `${ZONE_SET_NAME_PREFIX} [${zoneSetName}]`;
}

/** Quantity set name for one zone set on one basis, e.g.
 *  `IfcLite_ZoneVolumes [Takt areas] (net)`. The basis is IN THE NAME rather
 *  than only in a sibling property: a spreadsheet that pivots on quantity-set
 *  name would otherwise merge a net breakdown into a gross one silently. */
export function zoneQuantitySetName(zoneSetName: string, basis: VolumeBasis): string {
  return `${zoneQuantitySetPrefix(zoneSetName)}${volumeBasisLabel(basis)})`;
}

/**
 * What every basis's quantity-set name for ONE zone set starts with.
 *
 * A run has to recognise the quantity sets a PREVIOUS run left on an element,
 * on a different basis and therefore under a different name, to replace them
 * rather than accumulate one set per basis ever chosen. Scoped to the zone set,
 * so a run on "Sections" can never delete "Takt areas"'s numbers.
 */
export function zoneQuantitySetPrefix(zoneSetName: string): string {
  return `${ZONE_QUANTITY_SET_NAME_PREFIX} [${zoneSetName}] (`;
}

/** Quantity name for the part of an element in no zone of the set. Written so
 *  the quantities of one element sum to its whole volume - the reconciliation
 *  invariant #2508 asks for, made checkable in the exported file itself. */
export const OUTSIDE_QUANTITY_NAME = 'Outside zones';

/** Zone name substituted when a user has cleared one. Never left blank: a blank
 *  quantity name is not addressable in any downstream tool. */
export const UNNAMED_ZONE = 'Unnamed zone';

/** What the caller has established about one element, in SI. */
export interface ElementZoneFacts {
  /** Federated global id, resolved to model + expressId by the caller. */
  globalId: number;
  /** Name of the zone containing the element's centroid; `null` when its
   *  centroid is in no zone of the set (it can still touch zones). */
  homeZoneName: string | null;
  /** Every zone the element reaches, in zone-set order. Empty means the element
   *  belongs to this set not at all - those are skipped, not written blank. */
  touchedZoneNames: readonly string[];
  /** The same zones, by ID and in the same order. Names are unique only by
   *  convention (`types.ts`), so anything that MATCHES a zone must match on
   *  this: two zones a user called "Section 2" would otherwise collapse into
   *  one share and report it for both. */
  touchedZoneIds: readonly string[];
  straddles: boolean;
  /** Per-zone volume, SI cubic metres, on the basis named in the options. Empty
   *  when no volume could be established. */
  shares: ReadonlyArray<{ zoneId: string; zoneName: string; valueM3: number }>;
  /** SI cubic metres inside no zone of the set. */
  outsideM3: number;
  /** Why there are no volumes. `null` when `shares` is trustworthy - including
   *  the legitimate case of an element wholly inside one zone, whose single
   *  share is its whole volume and needed no clip. */
  refusal: WriteBackRefusal | null;
  /**
   * The declared quantity these magnitudes came from (`NetVolume`,
   * `NetSideVolume`, ...), or `null` for the `mesh` basis, which is measured.
   *
   * PER ELEMENT rather than per run, because one basis is not one quantity
   * name: `volumeBasisFromQuantityName` reads both `NetVolume` and
   * `NetSideVolume` as net, and a run that stamped a single name onto every
   * element would misattribute the number for whichever elements carry the
   * other one.
   */
  quantityName: string | null;
}

export interface ZoneWriteBackOptions {
  zoneSetName: string;
  /** The set's stable id, written into the property set so a later run can
   *  recognise its own output across a rename. */
  zoneSetId: string;
  basis: VolumeBasis;
  /** The model's own VOLUMEUNIT scale to SI, from
   *  `ProjectUnits.resolvedForUnitType('VOLUMEUNIT').siScale`. Values are
   *  DIVIDED by it on the way in, inverting the multiplication
   *  `declaredVolumeBases` does on the way out. */
  volumeSiScale: number;
}

export type WriteBackPropertyKind = 'LABEL' | 'BOOLEAN';

export interface WriteBackProperty {
  name: string;
  value: string | boolean;
  kind: WriteBackPropertyKind;
}

export interface WriteBackQuantity {
  name: string;
  /** In the FILE's declared volume unit, ready to write. */
  value: number;
}

/** Everything to write onto one element for one zone set. */
export interface ElementWriteBack {
  globalId: number;
  psetName: string;
  properties: WriteBackProperty[];
  /** `null` when no volume could be stated - the pset still carries the zone
   *  names and the reason. */
  qsetName: string | null;
  quantities: WriteBackQuantity[];
}

/** Property names, exported so tests and the removal path name them once. */
export const ZONE_PROPERTY_NAMES = {
  zoneSet: 'ZoneSet',
  /** The set's stable id. Written so a later run can find what an EARLIER one
   *  left on this element after the set was renamed: the set names carry the
   *  display name, and matching on that alone orphans everything written under
   *  the old one. Ids are what disambiguate a zone set (`types.ts`). */
  zoneSetId: 'ZoneSetId',
  zone: 'Zone',
  zones: 'Zones',
  straddles: 'Straddles',
  volumeBasis: 'VolumeBasis',
  volumeQuantity: 'VolumeQuantityName',
  volumeNote: 'VolumeNote',
  volumeUnavailable: 'VolumeUnavailable',
} as const;

/**
 * Why an element carries zone names but no volumes.
 *
 * The three geometric ones are `apportionment-cache.ts`'s, unchanged. The other
 * two are this module's own and could not arise before write-back existed:
 *
 * - `no-declared-quantity` - a run on a DECLARED basis reaches elements whose
 *   file declares no such quantity. Falling back to the mesh for those would put
 *   two different bases in one quantity set under one basis name, the exact
 *   confusion `volume-basis.ts` exists to prevent.
 * - `overlapping-zones` - the set's own zones overlap, so the shares
 *   double-count (`ElementApportionment.overlapping`). Each is individually
 *   correct and their sum is not, which is fine in a panel that says so and not
 *   fine in a quantity set, where a reader will add the rows up.
 */
export type WriteBackRefusal = ApportionmentRefusal | 'no-declared-quantity' | 'overlapping-zones';

/** One sentence per refusal, written INTO the file rather than left to the
 *  viewer. Whoever opens the export next does not have the zone panel. */
const REFUSAL_TEXT: Record<WriteBackRefusal, string> = {
  'no-geometry': 'No geometry was loaded for this element, so its volume could not be split.',
  'unproved-solid': 'Its mesh is not a proven closed solid, so no volume can be stated for it.',
  'rescaled-by-alignment':
    'Federation alignment rescaled this element\'s model, so its proved volume does not describe the geometry that was split.',
  'no-declared-quantity':
    'This element declares no volume quantity on the requested basis, so no volume was written for it.',
  'overlapping-zones':
    'The zones of this set overlap each other, so the per-zone volumes would double-count and not add up to the whole.',
};

/** A zone name safe to use as a quantity name, with collisions resolved.
 *
 *  Zone names are free text and are NOT unique-enforced (`types.ts` says so
 *  outright: ids disambiguate, names are convention). Two zones called "Section
 *  2" would otherwise write one quantity name twice, and the second silently
 *  replaces the first - a whole zone's volume vanishing with no error. The
 *  suffix is positional and therefore stable for a given zone order. */
function disambiguate(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((raw) => {
    const base = raw.trim() === '' ? UNNAMED_ZONE : raw.trim();
    let candidate = base;
    // The suffixed candidate is checked against the names already taken, not
    // just counted: zones named ['A', 'A', 'A (2)'] would otherwise produce
    // 'A (2)' twice and lose the third zone's volume, which is the same failure
    // the plain duplicate would have caused.
    for (let n = 2; taken.has(candidate); n++) candidate = `${base} (${n})`;
    taken.add(candidate);
    return candidate;
  });
}

/** Values below this many cubic metres are not written as a quantity row.
 *  Matches `NEGLIGIBLE_SHARE_REL`'s intent one level up: a zone the element only
 *  abuts contributes clip noise, and a nanolitre row in an exported file is
 *  noise a reader has to discard by hand. */
const NEGLIGIBLE_M3 = 1e-12;

/**
 * Build the write-back for one element.
 *
 * Returns `null` when the element belongs to no zone in this set - those get no
 * property set at all. Writing "this element is in no zone" onto every element
 * of a model would multiply the file's property sets by its element count to
 * say nothing; the absence of the pset already says it.
 */
export function buildElementWriteBack(
  facts: ElementZoneFacts,
  options: ZoneWriteBackOptions,
): ElementWriteBack | null {
  if (facts.touchedZoneNames.length === 0) return null;

  const scale = Number.isFinite(options.volumeSiScale) && options.volumeSiScale > 0
    ? options.volumeSiScale
    : 1;

  const properties: WriteBackProperty[] = [
    { name: ZONE_PROPERTY_NAMES.zoneSet, value: options.zoneSetName, kind: 'LABEL' },
    { name: ZONE_PROPERTY_NAMES.zoneSetId, value: options.zoneSetId, kind: 'LABEL' },
    // Empty rather than a sentinel like "(none)": a straddler whose centroid
    // falls between zones genuinely has no home zone, and any placeholder string
    // is a value a filter cannot tell apart from a zone actually named that.
    { name: ZONE_PROPERTY_NAMES.zone, value: facts.homeZoneName ?? '', kind: 'LABEL' },
    // Joined with ", " to match the Lists straddler convention (#1869), where
    // `equals` therefore excludes straddlers and `contains` includes them.
    { name: ZONE_PROPERTY_NAMES.zones, value: facts.touchedZoneNames.join(', '), kind: 'LABEL' },
    { name: ZONE_PROPERTY_NAMES.straddles, value: facts.straddles, kind: 'BOOLEAN' },
  ];

  if (facts.refusal) {
    properties.push({
      name: ZONE_PROPERTY_NAMES.volumeUnavailable,
      value: REFUSAL_TEXT[facts.refusal] ?? facts.refusal,
      kind: 'LABEL',
    });
    return { globalId: facts.globalId, psetName: zonePropertySetName(options.zoneSetName), properties, qsetName: null, quantities: [] };
  }

  const rows: Array<{ name: string; valueM3: number }> = facts.shares.map((s) => ({
    name: s.zoneName,
    valueM3: s.valueM3,
  }));
  if (facts.outsideM3 > NEGLIGIBLE_M3) {
    rows.push({ name: OUTSIDE_QUANTITY_NAME, valueM3: facts.outsideM3 });
  }
  const kept = rows.filter((r) => Number.isFinite(r.valueM3) && r.valueM3 > NEGLIGIBLE_M3);
  const names = disambiguate(kept.map((r) => r.name));
  const quantities: WriteBackQuantity[] = kept.map((r, i) => ({
    name: names[i],
    value: r.valueM3 / scale,
  }));

  if (quantities.length === 0) {
    return {
      globalId: facts.globalId,
      psetName: zonePropertySetName(options.zoneSetName),
      properties,
      qsetName: null,
      quantities: [],
    };
  }

  properties.push({ name: ZONE_PROPERTY_NAMES.volumeBasis, value: volumeBasisLabel(options.basis), kind: 'LABEL' });
  if (facts.quantityName) {
    properties.push({ name: ZONE_PROPERTY_NAMES.volumeQuantity, value: facts.quantityName, kind: 'LABEL' });
  }
  const note = volumeBasisRatioNote(options.basis);
  if (note) {
    properties.push({ name: ZONE_PROPERTY_NAMES.volumeNote, value: note, kind: 'LABEL' });
  }

  return {
    globalId: facts.globalId,
    psetName: zonePropertySetName(options.zoneSetName),
    properties,
    qsetName: zoneQuantitySetName(options.zoneSetName, options.basis),
    quantities,
  };
}

/** Summary of one write-back run, for the panel line and for tests. */
export interface WriteBackSummary {
  /** Elements that got a property set. */
  written: number;
  /** Of those, how many also got volumes. */
  withVolumes: number;
  /** Of those, how many carry a stated refusal instead. */
  refused: number;
  /** Elements in the set's assignments that touch no zone, so were skipped. */
  skippedNoZone: number;
}

export function summarize(
  results: ReadonlyArray<ElementWriteBack | null>,
): WriteBackSummary {
  let written = 0;
  let withVolumes = 0;
  let refused = 0;
  let skippedNoZone = 0;
  for (const r of results) {
    if (!r) {
      skippedNoZone++;
      continue;
    }
    written++;
    if (r.quantities.length > 0) withVolumes++;
    if (r.properties.some((p) => p.name === ZONE_PROPERTY_NAMES.volumeUnavailable)) refused++;
  }
  return { written, withVolumes, refused, skippedNoZone };
}
