/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RoofFootprintEdit } from '@ifc-lite/create';
import type { EntityRef } from '../types.js';
import { StoreStoreyNamespace } from './store-storey.js';

export class StoreRoofNamespace extends StoreStoreyNamespace {
  /**
   * Change a roof made by `addRoof` with `EdgeSlopes`/`Overhang`: one edge's
   * slope (`{ Edge: { Index, Slope } }`, radians), all of them (`EdgeSlopes`),
   * `Overhang` or `Thickness` (metres). The planes are rebuilt as one undoable
   * edit; a refusal (say, a slope steeper than 85°) writes nothing.
   */
  editRoof(ref: EntityRef, patch: RoofFootprintEdit): EntityRef {
    const method = this.backend.store.editRoof;
    if (!method) throw new Error('bim.store.editRoof: not available on this backend');
    return method.call(this.backend.store, ref, patch);
  }
}
