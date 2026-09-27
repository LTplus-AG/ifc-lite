/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** What kind of value the Lists engine compares for a condition (#6190), so an
 * editor offers the operators that can match it. It follows the engine's own
 * reads (`getConditionValue`): a zone VOLUME mode is a number, `Straddles` a
 * boolean, the zone name and the breakdown text, spatial levels, model file and
 * attributes text; material and classification are several texts; a property
 * may hold either, so it keeps every operator. */
import { isZoneVolumeMode } from './engine.js';
import type { PropertyCondition } from './types.js';

export type ListConditionValueKind = 'number' | 'boolean' | 'text' | 'texts' | 'any';

export function listConditionValueKind(source: PropertyCondition['source'], propertyName: string): ListConditionValueKind {
  switch (source) {
    case 'quantity':
    case 'geometry': return 'number';
    case 'property': return 'any';
    case 'material':
    case 'classification': return 'texts';
    case 'zone': {
      const mode = propertyName.toLowerCase();
      if (isZoneVolumeMode(mode)) return 'number';
      // The zone name, or every straddled zone joined, and the breakdown are text.
      return mode === 'straddles' ? 'boolean' : 'text';
    }
    default: return 'text';
  }
}
