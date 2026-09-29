/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The elements the `@ifc-lite/create` in-store builders make. Shared by the UI
 * add actions and the SDK `bim.store.add*` adapter. Their meshes come from the
 * wasm re-mesh of the written IFC (#6232), not from these params.
 */

import type {
  BeamInStoreParams,
  ColumnInStoreParams,
  DoorInStoreParams,
  MemberInStoreParams,
  PlateInStoreParams,
  RoofInStoreParams,
  SlabInStoreParams,
  SpaceInStoreParams,
  WallInStoreParams,
  WindowInStoreParams,
} from '@ifc-lite/create';

/** An element one of the `@ifc-lite/create` in-store builders makes, with the params it took. */
export type AuthoredElement =
  | { kind: 'column'; params: ColumnInStoreParams }
  | { kind: 'wall'; params: WallInStoreParams }
  | { kind: 'slab'; params: SlabInStoreParams }
  | { kind: 'beam'; params: BeamInStoreParams }
  | { kind: 'door'; params: DoorInStoreParams }
  | { kind: 'window'; params: WindowInStoreParams }
  | { kind: 'space'; params: SpaceInStoreParams }
  | { kind: 'roof'; params: RoofInStoreParams }
  | { kind: 'plate'; params: PlateInStoreParams }
  | { kind: 'member'; params: MemberInStoreParams };
