/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A profile entity read back as a `ProfileSection` (charter #6232, D2): the
 * inverse of `emitProfileSection`, for the inspector's Profile section, for
 * split (a piece of an I-beam is an I-beam) and for one undo of a change.
 *
 * The leading attributes of these classes are the same in every schema
 * (`ProfileType`, `ProfileName`, `Position`, then the dimensions in the order
 * listed below); only the optional tail differs, and it is not read. A class
 * that is not one of the nine, or a dimension that is missing or not a
 * positive finite number, reads as null.
 */

import type { ProfileSection, ProfileSectionType } from '@ifc-lite/create';
import { fromNativeLength } from '@ifc-lite/create';

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

/**
 * The section of a profile entity with STEP type `stepType` and raw
 * `attributes`, in metres (`lengthUnitScale` is native units to metres).
 */
export function sectionFromProfile(stepType: string, attributes: readonly unknown[], lengthUnitScale: number): ProfileSection | null {
  const layout = LAYOUT[stepType.toUpperCase()];
  if (!layout) return null;
  const section: Record<string, unknown> = { Type: layout.type };
  for (let i = 0; i < layout.names.length; i++) {
    const raw = realOf(attributes[3 + i]);
    if (raw === null || raw <= 0) return null;
    section[layout.names[i]] = fromNativeLength({ lengthUnitScale }, raw);
  }
  return section as unknown as ProfileSection;
}
