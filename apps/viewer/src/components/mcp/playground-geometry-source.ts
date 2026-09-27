/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One STEP snapshot for both viewer tessellation and playground clash. */

import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { LoadedPlaygroundModel } from './playground-dispatcher.js';

export interface PlaygroundGeometrySource {
  bytes: Uint8Array;
  store: IfcDataStore;
  /** True when pending edits were baked into these bytes. */
  materialized: boolean;
}

export async function playgroundGeometrySource(model: LoadedPlaygroundModel): Promise<PlaygroundGeometrySource> {
  if (!model.backend.getMutationView()?.hasPendingChanges()) {
    return { bytes: model.bytes, store: model.store, materialized: false };
  }

  // The mesher consumes STEP bytes and a matching parsed index. Exporting the
  // whole live model applies tombstones and creations together; passing the
  // original bytes with an effective id list would still mesh deleted records
  // and have no STEP record to decode for new ones.
  const schema = model.store.schemaVersion as 'IFC2X3' | 'IFC4' | 'IFC4X3';
  const content = model.bim.export.ifc(undefined, { schema });
  const bytes = typeof content === 'string'
    ? new TextEncoder().encode(content)
    : new Uint8Array(content);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
  return { bytes, store, materialized: true };
}
