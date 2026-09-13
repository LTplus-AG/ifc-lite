/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Naming helpers for the Export Changes artifact set (`buildChangedArtifacts`
 * in `model-changes.ts`): the STEP schema token a model exports as, and the
 * collision-free base name each produced file gets. Pure, no store access.
 */

/** Map any schema string to the STEP schema token (matches the legacy button). */
export function mapStepSchema(schemaVersion: string): 'IFC2X3' | 'IFC4' | 'IFC4X3' {
  return schemaVersion.includes('2X3')
    ? 'IFC2X3'
    : schemaVersion.includes('4X3')
      ? 'IFC4X3'
      : 'IFC4';
}

/**
 * Reserve a collision-free base for `base.ext`. fflate keys zip entries by
 * name and silently clobbers duplicates, and federated models frequently share
 * a name (and `sanitizeFilename` truncates to 60 chars), so two `model.ifc`
 * inputs must become `model.ifc` + `model-2.ifc`. Same base, different ext
 * (`model.ifc` + `model.ifcx`) do NOT collide.
 */
export function uniqueArtifactBase(base: string, ext: string, used: Set<string>): string {
  if (!used.has(`${base}.${ext}`)) {
    used.add(`${base}.${ext}`);
    return base;
  }
  let i = 2;
  while (used.has(`${base}-${i}.${ext}`)) i++;
  used.add(`${base}-${i}.${ext}`);
  return `${base}-${i}`;
}
