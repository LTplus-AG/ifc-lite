/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.move`'s scene and plan layers (charter #6232, C2): the base point,
 * the rubber band to the target and the live distance — a wall's anchor → end
 * layers, fed the move as a one-segment chain. The moved elements themselves
 * are the ghost meshes (3D) and their footprints (plan).
 */

import type { CommandHudProps, CommandPlanProps } from '@/lib/commands/modeling/types';
import { moveAsWallGesture, type ElementMoveGesture } from '@/lib/commands/modeling/commands/element-move-geometry';
import { WallPlaceScene } from './WallPlaceScene';
import { WallPlacePlan } from './WallPlacePlan';

export function ElementMoveScene({ gesture, ctx }: CommandHudProps<ElementMoveGesture>) {
  return <WallPlaceScene gesture={moveAsWallGesture(gesture)} ctx={ctx} />;
}

export function ElementMovePlan({ gesture, ctx, toScreen }: CommandPlanProps<ElementMoveGesture>) {
  return <WallPlacePlan gesture={moveAsWallGesture(gesture)} ctx={ctx} toScreen={toScreen} />;
}
