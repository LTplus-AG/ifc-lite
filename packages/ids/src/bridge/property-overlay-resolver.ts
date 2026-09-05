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
    const pset = result.find((p) => p.name === override.psetName);

    if (override.deleted) {
      if (pset) {
        pset.properties = pset.properties.filter((p) => p.name !== override.propName);
      }
      continue;
    }

    if (pset) {
      const idx = pset.properties.findIndex((p) => p.name === override.propName);
      if (idx >= 0) {
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
