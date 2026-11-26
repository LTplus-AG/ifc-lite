/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { addTranslation, assertRenderableTranslation, subtractTranslation } from './translation.js';
import { normalizeAngle, workspacePointToModelFrame, ZERO_ROTATION, type ModelRotation } from './rotation.js';
import { cancelPlacement, commitPlacements, placementFor, type ModelPlacement, type PlacementState } from './state.js';
import type { TwoPointAlignment } from './two-point-align.js';

/** A net heading below this is pick noise (float32 mesh vertices put ~1e-8 rad on
 * a pair that should cancel the heading), provided it barely moves the check point. */
const NET_HEADING_NOISE_RAD = 1e-6;
const NET_HEADING_NOISE_AT_B_M = 1e-3;

/**
 * Commit a two-point align to every named model as ONE undoable command.
 *
 * The alignment is a WORKSPACE transform, `w' = R(heading about A)(w) + (A' - A)`.
 * A placement stores an absolute heading about a pivot in the model's own frame,
 * applied before the translation, so the transform is folded in per model:
 *
 * - the pivot becomes A seen in the model's frame (`workspacePointToModelFrame`
 *   against the placement the model has NOW), so A is the one point the heading
 *   leaves in place;
 * - the heading adds to the model's current heading (the absolute value the bake
 *   wants, wrapped like `rotatePlacements`);
 * - the translation is then A' minus that pivot, which lands A exactly on A'.
 *
 * Per model rather than one shared pivot because models that were placed
 * differently before the align reach A through different translations and
 * headings. A pending move preview is carried, as `rotatePlacements` carries
 * it: the picks were taken on the DISPLAYED models.
 */
export function alignPlacements(
  state: PlacementState, ids: readonly string[], alignment: TwoPointAlignment,
): PlacementState {
  if (ids.length === 0) throw new Error('Choose at least one model to align.');
  const preview = state.preview;
  const target = addTranslation(alignment.pivot, alignment.delta);
  const noiseAngle = Math.min(NET_HEADING_NOISE_RAD, NET_HEADING_NOISE_AT_B_M / alignment.movingPlanLength);
  const before = new Map<string, ModelPlacement>();
  const after = new Map<string, ModelPlacement>();
  for (const id of new Set(ids)) {
    const placement = placementFor(state, id);
    if (placement.locked) throw new Error('Unlock the selected models before aligning them.');
    const shown: ModelPlacement = preview?.before.has(id)
      ? { ...placement, translation: addTranslation(placement.translation, preview.delta) } : placement;
    const pivot = workspacePointToModelFrame(alignment.pivot, shown);
    const summed = normalizeAngle(shown.rotation.angle + alignment.heading);
    const angle = Math.abs(summed) < noiseAngle ? 0 : summed;
    const translation = subtractTranslation(target, pivot);
    assertRenderableTranslation(translation);
    assertRenderableTranslation(pivot);
    const rotation: ModelRotation = angle === 0 ? ZERO_ROTATION : { angle, pivot };
    before.set(id, placement);
    after.set(id, { ...placement, translation, rotation });
  }
  return commitPlacements(cancelPlacement(state), before, after);
}
