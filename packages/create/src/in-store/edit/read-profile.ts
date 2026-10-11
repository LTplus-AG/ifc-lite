/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { getCanonicalEntityName } from '@ifc-lite/parser';

/**
 * A profile entity read back as a `ProfileSection` (charter #6232, D2): the
 * inverse of `emitProfileSection`, for the inspector's Profile section, for
 * split (a piece of an I-beam is an I-beam) and for one undo of a change.
 *
 * Attribute positions come from the model's schema registry. Supported optional
 * radii survive an edit or split; a populated geometry attribute the shared
 * builder cannot reproduce refuses editing rather than silently changing the
 * section. Invalid dimensions also read as null.
 */

import { fromNativeLength } from '../anchor.js';
import { validateProfileSection, type ProfileSection, type ProfileSectionType } from '../profile.js';
import { getAttributeNamesAcrossSchemas, getSchemaRegistryForVersion } from '@ifc-lite/parser';

/** IFC class (upper case, as STEP stores it) to section type and the attribute names from index 3. */
const LAYOUT: Readonly<Record<string, { type: ProfileSectionType; names: readonly string[] }>> = {
  IFCRECTANGLEPROFILEDEF: { type: 'Rectangle', names: ['XDim', 'YDim'] },
  IFCISHAPEPROFILEDEF: { type: 'I', names: ['OverallWidth', 'OverallDepth', 'WebThickness', 'FlangeThickness'] },
  IFCLSHAPEPROFILEDEF: { type: 'L', names: ['Depth', 'Width', 'Thickness'] },
  IFCTSHAPEPROFILEDEF: { type: 'T', names: ['Depth', 'FlangeWidth', 'WebThickness', 'FlangeThickness'] },
  IFCUSHAPEPROFILEDEF: { type: 'U', names: ['Depth', 'FlangeWidth', 'WebThickness', 'FlangeThickness'] },
  IFCCSHAPEPROFILEDEF: { type: 'C', names: ['Depth', 'Width', 'WallThickness', 'Girth'] },
  IFCCIRCLEPROFILEDEF: { type: 'Circle', names: ['Radius'] },
  IFCRECTANGLEHOLLOWPROFILEDEF: { type: 'RectangleHollow', names: ['XDim', 'YDim', 'WallThickness'] },
  IFCCIRCLEHOLLOWPROFILEDEF: { type: 'CircleHollow', names: ['Radius', 'WallThickness'] },
};

/** A REAL attribute: a plain number, or the `{ real }` wrapper the overlay keeps a whole-number REAL in. */
function realOf(raw: unknown): number | null {
  const value = typeof raw === 'object' && raw !== null && 'real' in raw ? (raw as { real: unknown }).real : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Whether `stepType` names one of the nine profile classes the picker writes. */
export function isSectionProfileClass(stepType: string | null | undefined): boolean {
  return stepType !== null && stepType !== undefined && stepType.toUpperCase() in LAYOUT;
}

/** Optional geometry the shared ProfileSection/emitProfileSection can reproduce. */
const OPTIONAL: Readonly<Partial<Record<ProfileSectionType, readonly string[]>>> = {
  I: ['FilletRadius'], L: ['FilletRadius'], T: ['FilletRadius'], U: ['FilletRadius'],
  C: ['InternalFilletRadius'], RectangleHollow: ['InnerFilletRadius', 'OuterFilletRadius'],
};

/** Read a profile in metres without dropping geometry when it is rebuilt. */
export function sectionFromProfile(
  stepType: string,
  attributes: readonly unknown[],
  lengthUnitScale: number,
  schemaVersion = 'IFC4',
): ProfileSection | null {
  const upper = stepType.toUpperCase();
  const layout = LAYOUT[upper];
  if (!layout || !Number.isFinite(lengthUnitScale) || lengthUnitScale <= 0) return null;
  let declared: readonly string[] | undefined;
  if (schemaVersion === 'IFC2X3' || schemaVersion === 'IFC4' || schemaVersion === 'IFC4X3') {
    const registry = getSchemaRegistryForVersion(schemaVersion);
    const name = getCanonicalEntityName(registry, upper);
    declared = name ? registry.entities[name].allAttributes?.map((attribute) => attribute.name) : undefined;
  } else if (schemaVersion === 'IFC5' && layout.type === 'Rectangle') {
    // IFCX adapts positional attributes using this same canonical name list.
    // Basic rectangular authoring remains supported; profiled emission refuses IFC5.
    declared = getAttributeNamesAcrossSchemas(stepType);
  }
  if (!declared || declared.length === 0) return null;
  // Extra positional values cannot be recreated by a builder using this registry.
  if (attributes.slice(declared.length).some((value) => value != null)) return null;
  const section: Record<string, unknown> = { Type: layout.type };
  const optional = OPTIONAL[layout.type] ?? [];
  for (let i = 3; i < declared.length; i++) {
    const field = declared[i];
    const required = layout.names.includes(field);
    const raw = attributes[i];
    if (raw == null && !required) continue;
    // The builder has no representation of slopes, edge radii or schema-specific
    // gravity offsets: refusing is safer than authoring a different cross-section.
    if (!required && !optional.includes(field)) return null;
    const value = realOf(raw);
    if (value === null || (required ? value <= 0 : value < 0)) return null;
    section[field] = fromNativeLength({ lengthUnitScale }, value);
  }
  const result = section as unknown as ProfileSection;
  try {
    validateProfileSection(result, 'profile');
  } catch (error) {
    // Malformed file dimensions are a normal refusal, not an editable section.
    if (error instanceof Error) return null;
    throw error;
  }
  return result;
}
