/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type IfcDataStore } from '@ifc-lite/parser';

import type { PropertySetInfo } from '../types.js';

import { collectAllPropertySets } from './properties.js';

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
 * the single source of truth for pset unwrapping/unit conversion/merging
 * — the overlay only patches the specific properties it names, so an
 * entity with no overrides sees byte-identical output to the no-overlay
 * path, and an entity WITH overrides keeps every other property untouched.
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
        // Keep the property's OWN stored name/casing — only its value
        // changes. Replacing it with `override.propName`'s casing would
        // just move the duplicate-entry risk from "two properties" to
        // "renamed property", with no benefit.
        pset.properties[idx] = { ...pset.properties[idx], value: override.value };
      } else {
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
