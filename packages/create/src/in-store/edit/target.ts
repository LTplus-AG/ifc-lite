/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { RandomSource } from '@ifc-lite/encoding';

export interface EditTarget {
  readonly dataStore: IfcDataStore;
  readonly view: MutablePropertyView;
  readonly editor: StoreEditor;
  /** Seeded `[0, 1)` source for the GlobalIds this edit authors; omit for the platform CSPRNG. See `SpatialAnchor.guidRandom`. */
  readonly guidRandom?: RandomSource;
}
