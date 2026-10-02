/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The elements the `@ifc-lite/create` in-store builders make. Shared by the UI
 * add actions and the SDK `bim.store.add*` adapter. Their meshes come from the
 * wasm re-mesh of the written IFC (#6232), not from these params.
 */

import type { DoorInStoreParams, OrdinaryInStoreElement, WindowInStoreParams } from '@ifc-lite/create';

/** Existing ordinary builder params plus the viewer's free door/window actions. */
export type AuthoredElement = OrdinaryInStoreElement
  | { kind: 'door'; params: DoorInStoreParams }
  | { kind: 'window'; params: WindowInStoreParams };
