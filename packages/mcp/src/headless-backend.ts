/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { HeadlessBackend } from '@ifc-lite/sdk/headless';
import type { IfcDataStore } from '@ifc-lite/parser';
import { createCachedHeadlessRoomGeometryProvider } from './headless-room-geometry.js';
import { provideHeadlessAlignGeometry } from './headless-backend-align.js';

export { expandTypes, isProductType } from '@ifc-lite/sdk/headless';

/** Preserve the MCP constructor while the shared SDK owns model/query/edit/export. */
export class HeadlessLikeBackend extends HeadlessBackend {
  constructor(store: IfcDataStore, modelName: string, modelId: string) {
    super(store, modelName, modelId, {
      roomGeometry: createCachedHeadlessRoomGeometryProvider(),
      alignGeometry: provideHeadlessAlignGeometry,
    });
  }
}
