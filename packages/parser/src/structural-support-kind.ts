/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BoundaryConditionInfo } from './structural-load-extractor.js';

/**
 * The support symbol a boundary condition draws as:
 * - `fixed`: every translation and every rotation fixed;
 * - `pinned`: every translation fixed, a rotation free;
 * - `roller`: some degree of freedom fixed, a translation free;
 * - `spring`: any degree of freedom with a finite stiffness.
 */
export type StructuralSupportKind = 'fixed' | 'pinned' | 'roller' | 'spring';

type Dof = 'fixed' | 'free' | 'spring';

/**
 * A stiffness at or above this is a rigid restraint. IFC2X3 has no boolean
 * branch, so exporters spell "fixed" as a large number: Axis writes 1e10
 * (`tests/models/structural/ifc_structuralanalysisview/`). Others write -1.
 */
const RIGID_STIFFNESS = 1e10;

/**
 * One degree of freedom. IFC4 and later write a fixed or free one as
 * `IfcBoolean` (`.T.` fixed). A negative stiffness means nothing physical, so
 * it reads as the -1 "fixed" convention; at least {@link RIGID_STIFFNESS} is
 * fixed; any other positive number is a spring. Zero or an omitted (`$`)
 * value is free.
 */
function dof(value: number | boolean | undefined): Dof {
  if (value === true) return 'fixed';
  if (value === undefined || value === false || value === 0) return 'free';
  return value < 0 || value >= RIGID_STIFFNESS ? 'fixed' : 'spring';
}

/** Component names by schema: `TranslationalStiffnessX` (IFC4), `LinearStiffnessX` (IFC2X3), and their ByLength/ByArea forms. */
const TRANSLATIONAL = /^(Translational|Linear)Stiffness(ByLength|ByArea)?[XYZ]$/;
const ROTATIONAL = /^RotationalStiffness(ByLength|ByArea)?[XYZ]$/;

function axisStates(condition: BoundaryConditionInfo, pattern: RegExp): Dof[] {
  const byAxis = new Map<string, Dof>();
  for (const [name, value] of Object.entries(condition.components)) {
    if (pattern.test(name)) byAxis.set(name.slice(-1), dof(value));
  }
  return ['X', 'Y', 'Z'].map((axis) => byAxis.get(axis) ?? 'free');
}

/** The support symbol for a condition, or null when it restrains nothing (an internal joint). */
export function structuralSupportKind(condition: BoundaryConditionInfo | undefined): StructuralSupportKind | null {
  if (!condition) return null;
  const translations = axisStates(condition, TRANSLATIONAL);
  const rotations = axisStates(condition, ROTATIONAL);
  const all = [...translations, ...rotations];
  if (all.includes('spring')) return 'spring';
  if (!all.includes('fixed')) return null;
  if (translations.every((d) => d === 'fixed')) return rotations.every((d) => d === 'fixed') ? 'fixed' : 'pinned';
  return 'roller';
}
