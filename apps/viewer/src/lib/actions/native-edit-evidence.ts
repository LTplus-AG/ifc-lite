/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProfileSection } from '@ifc-lite/create';
import { readElementProfileFromTarget } from '@/store/slices/mutation-element-profile';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { readAuthoringSizeFromTarget } from './model-authoring-size';
import type { ExpectedSize } from './model-authoring-size-params';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
export { entityName as nativeRootName } from '@/lib/commands/modeling/authored-kinds';

export interface NativeEditEvidence {
  units: 'm';
  dimensionsStatus: 'available' | 'unavailable';
  dimensions: ExpectedSize | null;
  profileStatus: 'available' | 'unavailable';
  Profile: ProfileSection | null;
}

/** No Qto inference: exact current native editable layout, with SI lengths regardless of display settings. */
export function nativeEditEvidence(target: ModelEditTarget | null, expressId: number): NativeEditEvidence {
  let dimensions: ExpectedSize | null = null;
  let Profile: ProfileSection | null = null;
  if (target && nativeLengthUnitAvailable(target)) {
    const type = target.editor.getEntityType(expressId)?.toUpperCase();
    if (type === 'IFCWALL' || type === 'IFCWALLSTANDARDCASE') dimensions = readAuthoringSizeFromTarget(target, expressId, 'wall');
    else if (type === 'IFCBEAM' || type === 'IFCCOLUMN' || type === 'IFCMEMBER') {
      dimensions = readAuthoringSizeFromTarget(target, expressId, 'linear');
      Profile = readElementProfileFromTarget(target, expressId);
    } else if (type === 'IFCSLAB' || type === 'IFCROOF' || type === 'IFCPLATE') dimensions = readAuthoringSizeFromTarget(target, expressId, 'slab');
  }
  // Refuse non-finite native values rather than JSON's silent NaN-to-null conversion.
  if (dimensions && Object.values(dimensions).some(value => typeof value === 'number' && !Number.isFinite(value))) dimensions = null;
  if (Profile && Object.values(Profile).some(value => typeof value === 'number' && !Number.isFinite(value))) Profile = null;
  return { units: 'm', dimensionsStatus: dimensions ? 'available' : 'unavailable', dimensions,
    profileStatus: Profile ? 'available' : 'unavailable', Profile };
}
