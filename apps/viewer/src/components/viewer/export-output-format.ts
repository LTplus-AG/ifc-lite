/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** What the export dialog's "Output" indicator shows, and the extension it writes. */
export interface ExportOutputInfo {
  ext: string;
  label: string;
}

/**
 * The file the current options actually produce.
 *
 * Kept out of `ExportDialog.tsx` because it is the one thing in that component
 * a reader checks against what landed on disk, and it is pure: four inputs,
 * no state. A LandXML→IFC4X3 conversion lands on the `.ifc` branch, which is
 * correct — it is a STEP file like any other (#4937).
 */
export function exportOutputInfo(
  isIfc5: boolean, changesOnly: boolean, packagesImages: boolean,
): ExportOutputInfo {
  if (changesOnly) {
    return isIfc5 ? { ext: '.ifcx', label: 'IFCX (JSON)' } : { ext: '.json', label: 'JSON' };
  }
  if (isIfc5) return { ext: '.ifcx', label: 'IFCX (JSON + USD geometry)' };
  return packagesImages ? { ext: '.ifczip', label: 'IFC + images' } : { ext: '.ifc', label: 'IFC (STEP)' };
}
