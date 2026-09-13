/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  ApplyStyleOptions,
  ApplyStyleResult,
  GenerateSpacesAllOptions,
  GenerateSpacesAllResult,
  StoreyInfo,
  SurfaceStyleColor,
} from '@ifc-lite/create';
import type { EntityRef } from './types.js';

/** Optional local-backend support for deriving IfcSpace entities. */
export interface SpacesBackendMethods {
  listStoreys(): StoreyInfo[];
  generate(options?: GenerateSpacesAllOptions): GenerateSpacesAllResult;
}

/** Optional local-backend support for persistent IFC presentation styles. */
export interface StyleBackendMethods {
  applyColors(
    batches: Array<{ refs: EntityRef[]; color: SurfaceStyleColor; name?: string }>,
    options?: ApplyStyleOptions,
  ): ApplyStyleResult[];
}
