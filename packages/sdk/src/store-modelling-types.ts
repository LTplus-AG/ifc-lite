/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store.addOpening` / `addHostedDoor` / `addHostedWindow` — openings and
 * wall-hosted fillings on a loaded model (#6232, M3 builder parity). Split out
 * of `types.ts` (allowlisted, at budget) like `store-structural-types.ts`, and
 * like it the param shapes come straight from `@ifc-lite/create`.
 */

import type {
  HostedDoorInStoreParams,
  HostedWindowInStoreParams,
  OpeningInStoreParams,
} from '@ifc-lite/create';
import type { EntityRef } from './types.js';

export interface ModellingStoreBackendMethods {
  /** `IfcOpeningElement` + `IfcRelVoidsElement` cut into an existing IfcWall or IfcSlab. Returns the opening. */
  addOpening(modelId: string, hostExpressId: number, params: OpeningInStoreParams): EntityRef;
  /** `IfcDoor` in a new opening of an IfcWall, linked by `IfcRelFillsElement`. Returns the door. */
  addHostedDoor(modelId: string, hostExpressId: number, params: HostedDoorInStoreParams): EntityRef;
  /** `IfcWindow` in a new opening of an IfcWall, linked by `IfcRelFillsElement`. Returns the window. */
  addHostedWindow(modelId: string, hostExpressId: number, params: HostedWindowInStoreParams): EntityRef;
}
