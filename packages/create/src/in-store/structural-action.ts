/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builders for `IfcStructuralPointAction` and
 * `IfcStructuralLinearAction` — the two `IfcStructuralActivity` subtypes
 * task S.1 asks for (#5167).
 *
 * Schema targeted: IFC4 (IFC4_ADD2_TC1.exp), verified against the generated
 * IFC4 registry's `allAttributes`:
 *   `IfcStructuralPointAction`: `GlobalId, OwnerHistory?, Name?,
 *    Description?, ObjectType?, ObjectPlacement?, Representation?,
 *    AppliedLoad, GlobalOrLocal, DestabilizingLoad?`
 *   `IfcStructuralLinearAction`: the same seven inherited attributes plus
 *    `ProjectedOrTrue?, PredefinedType` (from `IfcStructuralCurveAction`).
 *   `AppliedLoad`/`GlobalOrLocal` are MANDATORY on `IfcStructuralActivity`
 *   (no `?` in the registry) — both always written below, `GlobalOrLocal`
 *   defaulting to `GLOBAL_COORDS`.
 *   `IfcStructuralLinearAction`'s `ConstPredefinedType` WHERE rule forces
 *   `PredefinedType = CONST` — this builder hardcodes it; there is no
 *   parameter for it, because any other value is an EXPRESS violation.
 *   Each action's `AppliedLoad` is narrowed to the load types the
 *   `SuitableLoadType` WHERE rule accepts for that subtype:
 *   `IfcStructuralLoadSingleForce` for the point action,
 *   `IfcStructuralLoadLinearForce` for the linear action (both are also
 *   `IfcStructuralLoadStatic` → `IfcStructuralLoadOrResult` → `IfcStructuralLoad`).
 *
 * REPRESENTATION OWNERSHIP: neither action gets an `ObjectPlacement` or
 * `Representation` (both left `$`) — an action's location is implied by the
 * structural item it is connected to via `IfcRelConnectsStructuralActivity`
 * (`connectStructuralActivityToItemInStore` in `structural-relationships.ts`).
 * The schema makes both optional specifically to allow this; giving an
 * action independent geometry would create a second, easily-diverging
 * source of location truth for no read-side benefit
 * (`StructuralActivityInfo` carries no geometry field). The `AppliedLoad`
 * entity (`IfcStructuralLoadSingleForce`/`IfcStructuralLoadLinearForce`) IS
 * owned exclusively by its action — freshly created per call, never shared.
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import { ownerHistoryRef, productGuid } from './_emit-helpers.js';

export type StructuralGlobalOrLocal = 'GLOBAL_COORDS' | 'LOCAL_COORDS';

function boolAttr(v: boolean | undefined): '.T.' | '.F.' | null {
  return v === undefined ? null : v ? '.T.' : '.F.';
}

// ── IfcStructuralPointAction ────────────────────────────────────────────

export interface StructuralPointActionInStoreParams {
  Name?: string;
  Description?: string;
  ObjectType?: string;
  GlobalOrLocal?: StructuralGlobalOrLocal;
  DestabilizingLoad?: boolean;
  /** `IfcStructuralLoadSingleForce` components (all optional, at least one should be given). */
  LoadName?: string;
  ForceX?: number;
  ForceY?: number;
  ForceZ?: number;
  MomentX?: number;
  MomentY?: number;
  MomentZ?: number;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

export interface StructuralPointActionBuildResult {
  activityId: number;
  loadId: number;
}

export function addStructuralPointActionToStore(
  editor: StoreEditor,
  anchor: Pick<SpatialAnchor, 'ownerHistoryId' | 'guidRandom' | 'schema'>,
  params: StructuralPointActionInStoreParams,
): StructuralPointActionBuildResult {
  if (anchor.schema === 'IFC2X3') {
    throw new Error('addStructuralPointActionToStore: IFC2X3 has no IfcStructuralPointAction — target IFC4 or later');
  }
  const loadId = editor.addEntity('IfcStructuralLoadSingleForce', [
    params.LoadName ?? null,
    params.ForceX ?? null,
    params.ForceY ?? null,
    params.ForceZ ?? null,
    params.MomentX ?? null,
    params.MomentY ?? null,
    params.MomentZ ?? null,
  ]).expressId;

  const activityId = editor.addEntity('IfcStructuralPointAction', [
    productGuid(params, anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name ?? 'Point Action',
    params.Description ?? null,
    params.ObjectType ?? null,
    null, // ObjectPlacement — see module doc
    null, // Representation
    `#${loadId}`,
    `.${params.GlobalOrLocal ?? 'GLOBAL_COORDS'}.`,
    boolAttr(params.DestabilizingLoad),
  ]).expressId;

  return { activityId, loadId };
}

// ── IfcStructuralLinearAction ───────────────────────────────────────────

export interface StructuralLinearActionInStoreParams {
  Name?: string;
  Description?: string;
  ObjectType?: string;
  GlobalOrLocal?: StructuralGlobalOrLocal;
  DestabilizingLoad?: boolean;
  /** `IfcStructuralLoadLinearForce` components (all optional, at least one should be given). */
  LoadName?: string;
  LinearForceX?: number;
  LinearForceY?: number;
  LinearForceZ?: number;
  LinearMomentX?: number;
  LinearMomentY?: number;
  LinearMomentZ?: number;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

export interface StructuralLinearActionBuildResult {
  activityId: number;
  loadId: number;
}

export function addStructuralLinearActionToStore(
  editor: StoreEditor,
  anchor: Pick<SpatialAnchor, 'ownerHistoryId' | 'guidRandom' | 'schema'>,
  params: StructuralLinearActionInStoreParams,
): StructuralLinearActionBuildResult {
  if (anchor.schema === 'IFC2X3') {
    throw new Error('addStructuralLinearActionToStore: IFC2X3 has no IfcStructuralLinearAction — target IFC4 or later');
  }
  const loadId = editor.addEntity('IfcStructuralLoadLinearForce', [
    params.LoadName ?? null,
    params.LinearForceX ?? null,
    params.LinearForceY ?? null,
    params.LinearForceZ ?? null,
    params.LinearMomentX ?? null,
    params.LinearMomentY ?? null,
    params.LinearMomentZ ?? null,
  ]).expressId;

  const activityId = editor.addEntity('IfcStructuralLinearAction', [
    productGuid(params, anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name ?? 'Linear Action',
    params.Description ?? null,
    params.ObjectType ?? null,
    null, // ObjectPlacement — see module doc
    null, // Representation
    `#${loadId}`,
    `.${params.GlobalOrLocal ?? 'GLOBAL_COORDS'}.`,
    boolAttr(params.DestabilizingLoad),
    null, // ProjectedOrTrue
    '.CONST.', // PredefinedType — EXPRESS ConstPredefinedType WHERE rule
  ]).expressId;

  return { activityId, loadId };
}
