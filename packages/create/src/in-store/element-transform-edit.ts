/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { prepareGeneratedRoomUpdate } from './generated-room-update.js';
import { refreshTopAttachmentsInStore } from './top-attachment-refresh.js';
import { editOwnershipRefusal } from '@ifc-lite/export';
import { planElementTransform, type TransformPlan, type TransformRefusal } from './element-transform-plan.js';
import { rotateBy, unrotateBy } from './element-transform-frames.js';
import { translateProduct, resolvePlacementChain, translatedCoordinates } from './edit/placement-core.js';
import { rotateProductYaw, resolveRotationState, verticalRefDirectionRefusal } from './edit/placement-rotate.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { toNativeLength } from './anchor.js';
import { effectiveStoreyId } from './edit/effective-storey.js';
import { carryWallJoinsInStore } from './element-transform-joins.js';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { EditTarget } from './edit/target.js';

type Vec2 = [number, number];
export type StoreyTransformOp =
  | { readonly kind: 'move'; readonly delta: Vec2 }
  | { readonly kind: 'rotate'; readonly pivot: Vec2; readonly angle: number };

/** Storey-local IFC XY metres. The operation owns its atomic transaction. */
export interface ElementTransformInput extends EditTarget {
  readonly selected: readonly number[];
  readonly op: StoreyTransformOp;
  /** Viewer folds a render-space gesture through each owning storey's workplane. */
  operationForStorey?(storeyId: number): StoreyTransformOp;
  /** Different Align targets translate by different storey-local metre deltas. */
  translationForElement?(expressId: number, storeyId: number, delta: Vec2): Vec2;
  storeyOf?(expressId: number): number | null;
  /** Host hooks preserve its live mesh preview and undo bookkeeping. Deltas are parent-local metres. Hooks must write through the supplied atomic draft editor. */
  translate?(expressId: number, delta: [number, number, number], editor: StoreEditor): void;
  rotate?(expressId: number, angle: number, editor: StoreEditor): void;
  carryJoins?(plan: TransformPlan, editor: StoreEditor): readonly number[];
}

export function describeTransformRefusal(refusal: TransformRefusal): string {
  switch (refusal.reason) {
    case 'noStorey': return `#${refusal.expressId} is on no storey`;
    case 'noPlacement': return `#${refusal.expressId} has no placement`;
    default: return `#${refusal.expressId}'s placement does not hang from its storey`;
  }
}

export interface ElementTransformResult {
  readonly remesh: number[];
  readonly hostsChanged: boolean;
  readonly notices: string[];
}

export function transformElementsInStore(input: ElementTransformInput): ElementTransformResult {
  return input.editor.runAtomic(editor => transformElementsInDraft({ ...input, editor, view: editor.getMutationView() }));
}

function transformElementsInDraft(input: ElementTransformInput): ElementTransformResult {
  const opFor = (storeyId: number) => input.operationForStorey?.(storeyId) ?? input.op;
  const plan = planElementTransform({ ...input, storeyOf: input.storeyOf ?? (id => effectiveStoreyId(input.dataStore, input.view, id) ?? null) });
  if (plan.refused.length > 0) throw new Error(`Can't move ${plan.refused.map(describeTransformRefusal).join(', ')}.`);
  const steps = plan.roots.map(root => {
    const op = opFor(root.storeyId);
    if (op.kind === 'move') {
      const delta = input.translationForElement?.(root.expressId, root.storeyId, op.delta) ?? op.delta;
      if (!delta.every(Number.isFinite)) throw new Error('Move delta must be finite');
      return { root, delta, turn: 0 };
    }
    if (!op.pivot.every(Number.isFinite) || !Number.isFinite(op.angle)) throw new Error('Rotation pivot and angle must be finite');
    if (!root.upright) throw new Error(`#${root.expressId} is tilted; only upright elements turn about the vertical.`);
    const offset: Vec2 = [root.origin[0] - op.pivot[0], root.origin[1] - op.pivot[1]];
    const swung = rotateBy([Math.cos(op.angle), Math.sin(op.angle)], offset);
    const delta: Vec2 = [op.pivot[0] + swung[0] - root.origin[0], op.pivot[1] + swung[1] - root.origin[1]];
    if (!delta.every(Number.isFinite)) throw new Error('Rotation overflow: derived displacement must be finite');
    return { root, delta, turn: op.angle };
  });
  const unit = { lengthUnitScale: getModelLengthUnitScale(input.dataStore) };
  const prepared = steps.map(step => {
    const parentDelta = unrotateBy(step.root.parent.axis, step.delta);
    const nativeDelta: [number, number, number] = [toNativeLength(unit, parentDelta[0]), toNativeLength(unit, parentDelta[1]), 0];
    return { ...step, parentDelta, nativeDelta };
  });
  const writtenIds: number[] = [];
  for (const { root, delta, turn, nativeDelta } of prepared) {
    if (Math.hypot(...delta) > 1e-9) {
      const placement = resolvePlacementChain(input.dataStore, input.view, input.editor, root.expressId);
      if (!placement) throw new Error(`#${root.expressId} has no writable local placement`);
      if (!translatedCoordinates(placement.coordinates, nativeDelta)) throw new Error('Placement translation overflow: derived coordinates must be finite');
      writtenIds.push(placement.cartesianPointId);
    }
    if (turn !== 0) {
      const rotation = resolveRotationState(input.dataStore, input.view, input.editor, root.expressId);
      if (!rotation) throw new Error(`#${root.expressId} has no writable axis placement`);
      // Refuse before any write, so a multi-element turn changes nothing.
      const vertical = verticalRefDirectionRefusal(rotation);
      if (vertical) throw new Error(`#${root.expressId}: ${vertical}`);
      // An implicit RefDirection is materialised onto the axis placement itself (#8446).
      writtenIds.push(rotation.refDirectionId ?? rotation.axisPlacementId);
    }
  }
  if (new Set(writtenIds).size !== writtenIds.length) throw new Error('The selection shares writable placement leaves; shared occurrences cannot be transformed in place');
  const ownership = editOwnershipRefusal(input.dataStore, input.view, writtenIds, new Set([...plan.roots.map(root => root.expressId), ...plan.carried]));
  if (ownership) throw new Error(ownership);
  const notices: string[] = [];
  let updateRooms: () => number[] = () => [];
  try {
    updateRooms = prepareGeneratedRoomUpdate(input.dataStore, input.editor, plan.roots.filter(root => /^(IFCWALL|IFCWALLSTANDARDCASE|IFCCURTAINWALL)$/.test(input.editor.getEntityType(root.expressId)?.toUpperCase() ?? '')).map(root => root.storeyId), notices);
  } catch (error) {
    const notice = `Generated room updates unavailable (${error instanceof Error ? error.message : String(error)}); retained existing rooms.`;
    notices.push(notice); console.warn(`[auto-spaces] ${notice}`);
  }
  for (const { root, turn, parentDelta: [dx, dy], nativeDelta } of prepared) {
    if (Math.hypot(dx, dy) > 1e-9) {
      if (input.translate) input.translate(root.expressId, [dx, dy, 0], input.editor);
      else {
        const result = translateProduct(input.dataStore, input.view, input.editor, root.expressId, nativeDelta);
        if (!result.ok) throw new Error(result.reason);
      }
    }
    if (turn !== 0) {
      if (input.rotate) input.rotate(root.expressId, turn, input.editor);
      else {
        const result = rotateProductYaw(input.dataStore, input.view, input.editor, root.expressId, turn);
        if (!result.ok) throw new Error(result.reason);
      }
    }
  }
  const joined = input.carryJoins ? input.carryJoins(plan, input.editor) : carryWallJoinsInStore(input, plan, input.op.kind === 'rotate' ? input.op.angle : 0);
  const attached = refreshTopAttachmentsInStore(input, plan.roots.map(root => root.expressId), [...plan.roots.map(root => root.expressId), ...plan.carried, ...joined]);
  return {
    remesh: [...new Set([...plan.roots.map(root => root.expressId), ...plan.carried, ...joined, ...attached, ...updateRooms()])],
    hostsChanged: joined.length > 0,
    notices,
  };
}
