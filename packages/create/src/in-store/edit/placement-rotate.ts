/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Yaw rotation of an IfcProduct about Z, on the placement chain that
 * `placement-core.ts` reads. Implicit Axis and RefDirection slots are
 * written explicitly before the turn (#8446).
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { firstProjAxis } from '@ifc-lite/data';
import { asDirectionRatios, asExpressIdRef, readPlacementAttributes, resolvePlacementChain } from './placement-core.js';

/**
 * Snapshot of the placement's IfcAxis2Placement3D rotation.
 * A null direction id means the slot is implicit (STEP `$`). An implicit
 * RefDirection is reported as the renderer's fill, `firstProjAxis(Axis)`
 * (#5992): `[1, 0, 0]` when Axis is implicit too or `+Z`, the projection
 * of +X otherwise. Rotation materialises the implicit slots first (#8446).
 */
export interface RotationState {
  axisPlacementId: number;
  /** IfcAxis2Placement3D.Axis target, or null when implicit (STEP `$`). */
  axisDirectionId: number | null;
  refDirectionId: number | null;
  refDirection: [number, number, number];
  /** Current yaw about Z (rad). */
  yawZ: number;
}

export function resolveRotationState(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
): RotationState | null {
  const chain = resolvePlacementChain(dataStore, view, editor, expressId);
  if (!chain) return null;
  const axisAttrs = readPlacementAttributes(dataStore, view, editor, chain.axisPlacementId);
  if (!axisAttrs) return null;
  // IfcAxis2Placement3D index 1 = Axis, index 2 = RefDirection
  // (both optional IfcDirection refs; `$` selects the STEP default).
  const axisDirectionId = asExpressIdRef(axisAttrs[1]);
  const refDirectionId = asExpressIdRef(axisAttrs[2]);
  if (refDirectionId === null) {
    // The frame the renderer draws, not +X: a tilted Axis moves the fill.
    const axisAttrs = axisDirectionId === null ? null : readPlacementAttributes(dataStore, view, editor, axisDirectionId);
    const axis = axisAttrs ? asDirectionRatios(axisAttrs[0]) : null;
    if (axisDirectionId !== null && !axis) return null;
    const fill = axis ? firstProjAxis(axis) : [1, 0, 0] as [number, number, number];
    return { axisPlacementId: chain.axisPlacementId, axisDirectionId, refDirectionId: null, refDirection: fill, yawZ: Math.atan2(fill[1], fill[0]) };
  }
  const dirAttrs = readPlacementAttributes(dataStore, view, editor, refDirectionId);
  if (!dirAttrs) return null;
  // IfcDirection index 0 = DirectionRatios (list of doubles).
  const ratios = asDirectionRatios(dirAttrs[0]);
  if (!ratios) return null;
  // Yaw about Z derived from the in-plane direction. Numerically
  // stable for any unit-length input; for non-unit inputs we still
  // recover the angle from atan2.
  const yawZ = Math.atan2(ratios[1], ratios[0]);
  return { axisPlacementId: chain.axisPlacementId, axisDirectionId, refDirectionId, refDirection: ratios, yawZ };
}

/**
 * A yaw turns RefDirection's horizontal part about Z. A vertical
 * RefDirection has none, so the turn would leave the placement unchanged
 * while the caller reports success: refuse it until rotating the whole
 * frame is supported.
 */
export function verticalRefDirectionRefusal(state: RotationState): string | null {
  const [x, y, z] = state.refDirection;
  if (Math.hypot(x, y) > 1e-9 * Math.hypot(x, y, z)) return null;
  return 'Cannot rotate about Z: the placement\'s RefDirection is vertical, so the turn would not change the placement';
}

export type RotateResult =
  | { ok: true; oldYawZ: number; newYawZ: number; newRefDirection: [number, number, number] }
  | { ok: false; reason: string };

/**
 * Rotate an IfcProduct about the storey-up Z axis by `deltaYaw`
 * radians. Updates RefDirection on the IfcAxis2Placement3D in place
 * when one already exists.
 *
 * When the placement leaves RefDirection implicit (the `[1, 0, 0]`
 * STEP default) — routine in parsed files, whose exporters omit
 * default axes — the implicit slots are first written explicitly
 * with the frame they stand for: Axis as `[0, 0, 1]` when it too is
 * implicit, RefDirection as the `firstProjAxis(Axis)` fill (#8446). The writes go through the
 * caller's editor, so an atomic or compound caller groups them with
 * the rotation into one undo step and nothing is orphaned on undo.
 */
export function rotateProductYaw(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
  deltaYaw: number,
): RotateResult {
  const state = resolveRotationState(dataStore, view, editor, expressId);
  if (!state) {
    return {
      ok: false,
      reason:
        'Entity placement is not a simple IfcLocalPlacement → IfcAxis2Placement3D chain',
    };
  }
  const vertical = verticalRefDirectionRefusal(state);
  if (vertical) return { ok: false, reason: vertical };
  const newYaw = state.yawZ + deltaYaw;
  // Keep the in-plane length so a tilted direction turns about Z unchanged in slope.
  const inPlane = Math.hypot(state.refDirection[0], state.refDirection[1]);
  const newRatios: [number, number, number] = [inPlane * Math.cos(newYaw), inPlane * Math.sin(newYaw), state.refDirection[2]];
  if (!Number.isFinite(newYaw) || !newRatios.every(Number.isFinite)) return { ok: false, reason: 'Placement rotation overflow: derived direction must be finite' };
  let refDirectionId = state.refDirectionId;
  if (refDirectionId === null) {
    // Materialise the implicit defaults before rotating (#8446); the
    // finite check above runs first, so a refused rotation creates nothing.
    if (state.axisDirectionId === null) {
      const axis = editor.addEntity('IfcDirection', [[0, 0, 1]]);
      editor.setPositionalAttribute(state.axisPlacementId, 1, `#${axis.expressId}`);
    }
    const refDirection = editor.addEntity('IfcDirection', [state.refDirection]);
    editor.setPositionalAttribute(state.axisPlacementId, 2, `#${refDirection.expressId}`);
    refDirectionId = refDirection.expressId;
  }
  editor.setPositionalAttribute(refDirectionId, 0, newRatios);
  return { ok: true, oldYawZ: state.yawZ, newYawZ: newYaw, newRefDirection: newRatios };
}
