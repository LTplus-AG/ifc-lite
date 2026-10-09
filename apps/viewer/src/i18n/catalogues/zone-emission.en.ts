/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export const zoneEmissionEn = {
  'zoneEmission.title': 'Review evaluated zone emission',
  'zoneEmission.hint': 'Emit this whole evaluated zone set into only the chosen model. Membership comes from the native current evaluation.',
  'zoneEmission.limit': 'Earlier outputs from this session are replaced. Zones imported from a previous IFC file remain. Other models are untouched. An emitted solid preview is unavailable.',
  'zoneEmission.prepare': 'Prepare native zone emission',
  'zoneEmission.apply': 'Emit reviewed zones',
  'zoneEmission.population': '{zones} zones, {members} evaluated elements, {replaced} prior zones replaced; {imported} imported zones retained.',
  'zoneEmission.records': 'Native output records',
  'zoneEmission.frame': 'Native model units and coordinate frame',
  'zoneEmission.receiptProblem': 'The model changed, but the receipt could not be saved. Undo remains available in the native Changes panel.',
} as const;
