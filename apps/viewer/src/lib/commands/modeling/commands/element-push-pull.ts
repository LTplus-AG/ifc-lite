/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.pushPull` (charter #6232, C4): pull a face of the selected
 * element to change one dimension. A wall's top sets its height and its sides
 * its thickness, a slab's far face its thickness, a column's or beam's ends
 * its length.
 *
 * Grab a face handle (`PushPullHandles`) and drag: the face follows the
 * pointer, snapped to the floor levels or a step, and release writes ONE
 * `setElementSize`. A click without a drag arms the face instead: move, click
 * or type a size (the field, or digits) and Enter commits. Escape leaves with
 * nothing written.
 *
 * The write is the inspector's (`setElementSize`, `store/slices/
 * mutation-element-size.ts`): what a handle produces and what typing the
 * dimension into the Dimensions row produces cannot differ. It runs in one
 * transaction, so it is one undo step, and the element (and the openings it
 * re-cut) re-mesh through the wasm service. A commit the element's openings
 * cannot follow (a wall lowered below a door) is refused with the reason.
 */

import { PushPullBar } from '@/components/viewer/tools/command/PushPullBar';
import { PushPullScene } from '@/components/viewer/tools/command/PushPullHandles';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { useViewerStore } from '@/store';
import { commitElementSize } from '@/lib/element-size-commit';
import { faceOf, sizeOf, type PushPullGesture } from '@/lib/push-pull/push-pull-gesture';
import { readPushPullTarget } from '@/lib/push-pull/push-pull-target';
import { PUSH_PULL_COMMAND_ID } from '@/lib/push-pull/push-pull-drag';
import { MIN_SIZE } from '@/lib/push-pull/push-pull-snap';
import { commandGhostId } from '../ghost.js';
import { prismGhostMesh } from '../ghost-shapes.js';
import type { CommandContext, CommandField, ModelingCommand } from '../types.js';

function init(ctx: CommandContext): PushPullGesture {
  const s = ctx.get();
  const empty: PushPullGesture = { target: null, faceId: null, size: null, typed: false, snapped: null };
  if (s.selectedEntityId === null) return empty;
  const { modelId, expressId } = resolveEntityRef(s.selectedEntityId);
  return { ...empty, target: s.models.has(modelId) ? readPushPullTarget(s, modelId, expressId) : null };
}

const SIZE_FIELD: CommandField<PushPullGesture> = {
  id: 'size',
  labelKey: 'pushPull.field.size',
  unit: 'm',
  hidden: (g) => g.faceId === null,
  read: sizeOf,
  write: (g, v) => ({ ...g, size: Math.max(MIN_SIZE, Math.abs(v)), typed: true, snapped: null }),
};

export const ELEMENT_PUSH_PULL: ModelingCommand<PushPullGesture> = {
  id: PUSH_PULL_COMMAND_ID,
  labelKey: 'pushPull.label',
  hud: {
    Bar: PushPullBar,
    Scene: PushPullScene,
    hint: (g) => (!g.target ? 'pushPull.hint.noTarget' : g.faceId === null ? 'pushPull.hint.pick' : 'pushPull.hint.drag'),
  },
  fields: [SIZE_FIELD],
  snap: 'modeling',
  init,
  // The drag is followed on the window (`push-pull-drag.ts`), in pixels along the face's own axis;
  // the workplane cursor has no meaning for a vertical face.
  pointerMove: (g) => g,
  // A click once a face is armed and has a size writes it.
  pointerDown: (g) => (g.faceId !== null && g.size !== null ? { commit: true } : g),
  validate(g) {
    const face = faceOf(g);
    if (!g.target || !face) return { ok: false, reasonKey: g.target ? 'pushPull.hint.pick' : 'pushPull.hint.noTarget' };
    const size = sizeOf(g);
    return size !== null && size >= MIN_SIZE && Math.abs(size - face.size) > 1e-6 ? { ok: true } : { ok: false, reasonKey: 'pushPull.unchanged' };
  },
  commit(g, tx) {
    const face = faceOf(g);
    const size = sizeOf(g);
    if (!g.target || !face || size === null) throw new Error('No face to push or pull');
    const { modelId, expressId } = g.target;
    const outcome = commitElementSize(useViewerStore, modelId, expressId, face.patch(size));
    if (!outcome.ok) throw new Error(outcome.reason);
    return { modelId, created: [], deleted: [], remesh: outcome.remesh, select: [expressId] };
  },
  afterCommit: () => ({ exit: true }),
  cancel: () => 'exit',
  ghost(g, ctx) {
    const face = faceOf(g);
    const size = sizeOf(g);
    if (!g.target || !face || size === null || g.size === null) return [];
    const prism = g.target.prism(face, size);
    const mesh = prism && prismGhostMesh(g.target.plane, prism.outline, prism.z0, prism.z1, commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
