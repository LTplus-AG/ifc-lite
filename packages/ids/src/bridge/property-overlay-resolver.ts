/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type IfcDataStore } from '@ifc-lite/parser';

import type { PropertySetInfo } from '../types.js';

import { collectAllPropertySets } from './properties.js';
import { resolveEntityMeasureScales, toBaseSI } from './units.js';

/**
 * One pending, in-memory correction to a property value, applied on top
 * of the canonical (parsed) projection without re-exporting the model.
 * Mirrors the viewer's `MutablePropertyView` mutation shape without a
 * dependency on `@ifc-lite/mutations` — callers (the viewer) adapt their
 * mutation view's per-entity mutation list into this shape.
 */
export interface PropertyOverride {
  /** Property set name, exactly as written (case-sensitive). */
  psetName: string;
  /** Property name, exactly as written (case-sensitive). */
  propName: string;
  /** The corrected value, or `null`/`deleted` to remove the property. */
  value: string | number | boolean | null;
  /** True when the property was deleted rather than set. */
  deleted?: boolean;
}

/**
 * Resolves the pending property overrides for one entity, or `undefined`
 * when the entity has none. Called on every property read, so it must be
 * cheap (an O(1)/O(mutations-for-entity) map lookup, not a scan).
 */
export type PropertyOverlayResolver = (expressId: number) => PropertyOverride[] | undefined;

/**
 * Property sets for `expressId`, with any pending overlay writes applied
 * on top of the canonical (parsed) result. The canonical projection stays
 * the single source of truth for pset unwrapping/merging — the overlay
 * only patches the specific properties it names, so an entity with no
 * overrides sees byte-identical output to the no-overlay path, and an
 * entity WITH overrides keeps every other property untouched.
 *
 * An override's OWN value, however, does still go through unit
 * conversion here (`toBaseSI` below, keyed off the same
 * `resolveEntityMeasureScales` the canonical projection uses): a
 * `PropertyOverride.value` is written in the model's raw storage frame
 * (mirroring `MutablePropertyView.setProperty`), the same frame the
 * canonical projection's OWN properties start in before
 * `projectProperty` scales them — so splicing it in unconverted would
 * leave it in the wrong unit frame relative to its neighbours.
 *
 * Pset/property name matching here is deliberately CASE-INSENSITIVE, to
 * match `getPropertyValue`/`getPropertySets` in ./data-accessor.ts (both
 * compare via `.toLowerCase()`, to tolerate real-world IFC files with
 * inconsistent Pset/property-name casing). An exact-case `find`/`findIndex`
 * here would silently miss a base property whose stored name differs only
 * in case from the override's target: the override would land as a NEW,
 * separately-cased property instead of replacing the existing one, and
 * `getPropertyValue`'s case-insensitive scan would then return the OLD,
 * uncorrected entry (it iterates in array order and the untouched base
 * property comes first) — a correction that reads back as applied through
 * this same accessor (case-insensitively) yet never becomes visible to a
 * re-run of IDS validation through the very same accessor. Matching
 * case-insensitively here, and preserving each existing entry's own
 * stored casing on update, keeps this merge and the read path that
 * consumes it in agreement.
 */
export function resolveEffectivePropertySets(
  store: IfcDataStore,
  expressId: number,
  propertyOverlay: PropertyOverlayResolver | undefined
): PropertySetInfo[] {
  const base = collectAllPropertySets(store, expressId);
  const overrides = propertyOverlay?.(expressId);
  if (!overrides || overrides.length === 0) return base;

  // Deep-clone only what we might mutate (psets/properties arrays), so the
  // base projection's cached/shared objects are never touched.
  const result = base.map((pset) => ({
    ...pset,
    properties: pset.properties.map((p) => ({ ...p })),
  }));

  // The overlay's raw values (a `PropertyOverride.value` mirrors whatever
  // was written through `MutablePropertyView.setProperty`, e.g. an IDS
  // correction — see property-overlay-resolver.ts's own module doc) live
  // in the SAME raw, author-unit frame `base`'s own properties started in
  // BEFORE `projectProperty` (properties.ts) ran them through
  // `applyUnitConversion`. Splicing an override in unconverted would leave
  // it in the wrong frame relative to every other property in the same
  // pset — under a `MILLI` project, a raw `0.9` reads as `0.9` base-SI
  // metres instead of the `0.0009` it actually is. `resolveEntityMeasureScales`
  // is the SAME per-entity resolver `collectAllPropertySets`/`projectProperty`
  // already used to build `base`, so this can't drift into a second,
  // parallel unit path.
  const scales = resolveEntityMeasureScales(store, expressId);

  for (const override of overrides) {
    const psetLower = override.psetName.toLowerCase();
    const propLower = override.propName.toLowerCase();
    const pset = result.find((p) => p.name.toLowerCase() === psetLower);

    if (override.deleted) {
      if (pset) {
        pset.properties = pset.properties.filter((p) => p.name.toLowerCase() !== propLower);
      }
      continue;
    }

    if (pset) {
      const idx = pset.properties.findIndex((p) => p.name.toLowerCase() === propLower);
      if (idx >= 0) {
        // Keep the property's OWN stored name/casing AND dataType — only
        // its value changes. The existing entry's `dataType` (resolved by
        // `projectProperty` from the IFC schema, not from this override)
        // is what tells `toBaseSI` whether — and by which dimension — to
        // scale: a non-measure property (IFCLABEL, boolean, identifier)
        // has no scale and passes through untouched.
        const existing = pset.properties[idx];
        pset.properties[idx] = {
          ...existing,
          value: toBaseSI(override.value, existing.dataType, scales),
        };
      } else {
        // No existing entry to read a dataType from, so `override.value`
        // is spliced in as-is (unscaled). `PropertyOverride` carries no
        // dataType of its own — see its doc — so a correction that
        // CREATES a brand-new measure property (rather than correcting an
        // existing one) is out of scope for this frame conversion.
        pset.properties.push({ name: override.propName, value: override.value, dataType: '' });
      }
    } else {
      result.push({
        name: override.psetName,
        properties: [{ name: override.propName, value: override.value, dataType: '' }],
      });
    }
  }

  return result;
}
