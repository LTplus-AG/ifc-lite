/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Synchronous roof edits reuse the runtime already loaded by startCollab.
// A runtime import here would pull Yjs into the viewer's eager boot graph.
type PropertyApi = Pick<typeof import('@ifc-lite/collab'), 'getPropertyValue' | 'setPropertyValue' | 'deletePropertyValue'>;
let api: PropertyApi | null = null;

export function bindRoomPropertyApi<T extends PropertyApi>(runtime: T): T {
  api = runtime;
  return runtime;
}

export function roomPropertyApi(): PropertyApi {
  if (!api) throw new Error('Collaboration property runtime is not loaded');
  return api;
}
