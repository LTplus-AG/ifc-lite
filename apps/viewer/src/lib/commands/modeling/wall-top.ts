/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The top of a wall the Wall tool draws (#9013). "Storey above" makes the wall
 * reach the storey above the workplane and records that attachment
 * (`IfcLite_StoreyAttachment.TopConstraint`), so a later floor-to-floor edit
 * resizes it; with no storey above yet it keeps the default height and is
 * recorded as `NextStoreyAbove`, which the first storey added above binds.
 * "Fixed height" writes the default height and no attachment.
 */

import { PropertyValueType } from '@ifc-lite/data';
import { NEXT_STOREY_ABOVE, STOREY_ATTACHMENT_PSET } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { authoringDim } from '@/store/slices/authoringDefaultsSlice';
import { modelStoreys, type WorkspaceStorey } from './workspace-storeys.js';

/** Below this an attached wall would be a sliver: draw the default height instead. */
const MIN_ATTACHED_HEIGHT = 0.1;

export interface WallTopResolution {
  /** Metres from the workplane up. */
  readonly Height: number;
  /** The TopConstraint to record, or null for a fixed-height wall. */
  readonly attachTo: string | null;
  /** The storey the top reaches, when there is one. */
  readonly above: WorkspaceStorey | null;
}

type State = Pick<ViewerState, 'authoringDefaults' | 'models' | 'mutationViews'>;

export function resolveWallTop(s: State, modelId: string, storeyId: number | null, baseZ: number): WallTopResolution {
  const fixed = authoringDim(s.authoringDefaults, 'wall', 'Height');
  if (s.authoringDefaults.wallTop === 'fixed' || storeyId === null) return { Height: fixed, attachTo: null, above: null };
  const storeys = modelStoreys(s, modelId);
  const index = storeys.findIndex((storey) => storey.expressId === storeyId);
  if (index < 0) return { Height: fixed, attachTo: null, above: null };
  const above = storeys[index + 1];
  if (!above) return { Height: fixed, attachTo: NEXT_STOREY_ABOVE, above: null };
  const height = above.elevation - storeys[index].elevation - baseZ;
  if (height < MIN_ATTACHED_HEIGHT) return { Height: fixed, attachTo: null, above: null };
  return { Height: height, attachTo: storeyGlobalId(s, modelId, above.expressId), above };
}

function storeyGlobalId(s: State, modelId: string, storeyId: number): string | null {
  const created = s.mutationViews.get(modelId)?.getNewEntity(storeyId)?.attributes[0];
  if (typeof created === 'string') return created;
  const guid = s.models.get(modelId)?.ifcDataStore?.entities.getGlobalId(storeyId);
  return guid ? guid : null;
}

/**
 * A height the user typed for the next wall means that height: the wall
 * becomes fixed unless it would already reach exactly that high. On the top
 * storey (`NextStoreyAbove`) there is no height to match, so it is fixed too.
 */
export function typeWallHeight(
  s: Pick<ViewerState, 'setAuthoringDims' | 'setAuthoringDefaults'>, top: WallTopResolution | null, Height: number,
): void {
  s.setAuthoringDims('wall', { Height });
  if (!top || (top.attachTo !== null && (top.above === null || Math.abs(top.Height - Height) > 1e-9))) {
    s.setAuthoringDefaults({ wallTop: 'fixed' });
  }
}

/** Record a placed wall's attachment in the caller's undo batch. Throws when the write is refused. */
export function recordWallTop(s: Pick<ViewerState, 'setProperty'>, modelId: string, wallId: number, attachTo: string): void {
  const written = s.setProperty(modelId, wallId, STOREY_ATTACHMENT_PSET, 'TopConstraint', attachTo, PropertyValueType.Label);
  if (!written) throw new Error(`Couldn't record the top of wall #${wallId}`);
}
