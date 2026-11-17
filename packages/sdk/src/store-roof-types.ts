/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RoofFootprintEdit } from '@ifc-lite/create';
import type { EntityRef } from './types.js';

/** `bim.store` roofs by footprint (#9296 round 3). */
export interface RoofStoreBackendMethods {
  /** Change a roof by footprint's slopes, overhang or thickness and rebuild its planes, atomically. */
  editRoof?(ref: EntityRef, patch: RoofFootprintEdit): EntityRef;
}
