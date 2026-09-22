/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store.addStructural*` / `connectStructural*` / `assignToStructuralGroup`
 * stubs for the MCP v0.1 headless backend (#5167 task S.1) — the same
 * convention `headless-backend-cost-store.ts` and `headless-backend.ts`'s
 * `addColumn`/`addWall`/etc. already use: agent flows go through
 * `entity_create` with raw attributes rather than the high-level builders, so
 * these throw loudly instead of silently no-opping.
 *
 * This is deliberately a stub, not an omission. MCP has no element-creation
 * tool surface at all, so wiring real structural authoring here would expand
 * v0.1's scope rather than complete S.1.
 *
 * Note on reads: `bim.structural` here is constructed over the parsed data
 * store alone, so it does NOT see a structural row authored this session
 * through `entity_create` — that row lives in the mutation overlay. An earlier
 * revision of this comment claimed otherwise; correcting it rather than
 * leaving a claim the code does not support (#5167 review).
 */

import type { StructuralStoreBackendMethods } from '@ifc-lite/sdk';

const unsupported = (method: string) => (): never => {
  throw new Error(`${method} not supported in MCP v0.1; use entity_create`);
};

export function structuralStoreStubs(): StructuralStoreBackendMethods {
  return {
    addStructuralAnalysisModel: unsupported('addStructuralAnalysisModel'),
    addStructuralCurveMember: unsupported('addStructuralCurveMember'),
    addStructuralPointConnection: unsupported('addStructuralPointConnection'),
    addStructuralLoadGroup: unsupported('addStructuralLoadGroup'),
    addStructuralPointAction: unsupported('addStructuralPointAction'),
    addStructuralLinearAction: unsupported('addStructuralLinearAction'),
    connectStructuralMemberToConnection: unsupported('connectStructuralMemberToConnection'),
    connectStructuralActivityToItem: unsupported('connectStructuralActivityToItem'),
    assignToStructuralGroup: unsupported('assignToStructuralGroup'),
  };
}
