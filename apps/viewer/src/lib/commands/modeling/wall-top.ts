/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The top of a wall, column or curtain wall the Model workspace draws
 * (#9013, #9296). "Storey above" makes the element reach the storey above the
 * workplane and records that attachment (`IfcLite_StoreyAttachment
 * .TopConstraint`, with `TopBinding` `Relative`: Archicad's "home storey + 1"),
 * so a later floor-to-floor edit resizes it, an inserted storey re-binds it
 * and a copy to another storey attaches to the storey above its new one.
 * With no storey above yet it keeps the default height and is recorded as
 * `NextStoreyAbove`, which the first storey added above binds. "Fixed height"
 * writes the default height and no attachment. A beam keeps the height and
 * underside it is drawn with and is attached when its top lands on the storey
 * above (`beamTopAttachment`).
 */

import { PropertyValueType } from '@ifc-lite/data';
import { NEXT_STOREY_ABOVE, RELATIVE_BINDING, STOREY_ATTACHMENT_PSET, TOP_BINDING } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { authoringDim } from '@/store/slices/authoringDefaultsSlice';
import { modelStoreys, type WorkspaceStorey } from './workspace-storeys.js';

/** Below this an attached wall would be a sliver: draw the default height instead. */
export const MIN_ATTACHED_HEIGHT = 0.1;

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
  return resolveElementTop(s, modelId, storeyId, baseZ, authoringDim(s.authoringDefaults, 'wall', 'Height'));
}

/** The wall rule for any element drawn upwards from `baseZ`, `fixed` being its own default height. */
export function resolveElementTop(s: State, modelId: string, storeyId: number | null, baseZ: number, fixed: number): WallTopResolution {
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
 * becomes fixed, even when the value matches the storey spacing it would
 * reach (a field the user did not touch never writes, so this is a typed
 * value). A later re-level then never resizes it.
 */
export function typeWallHeight(s: Pick<ViewerState, 'setAuthoringDims' | 'setAuthoringDefaults'>, Height: number): void {
  s.setAuthoringDims('wall', { Height });
  s.setAuthoringDefaults({ wallTop: 'fixed' });
}

/**
 * A beam drawn on `storeyId` whose top is `topZ` above the storey floor: the
 * storey above's GlobalId when the top lands on it (within 1 mm) under the
 * "Storey above" default, else null (a fixed beam).
 */
export function beamTopAttachment(s: State, modelId: string, storeyId: number | null, topZ: number): string | null {
  if (s.authoringDefaults.wallTop === 'fixed' || storeyId === null) return null;
  const storeys = modelStoreys(s, modelId);
  const index = storeys.findIndex((storey) => storey.expressId === storeyId);
  const above = index >= 0 ? storeys[index + 1] : undefined;
  if (!above || Math.abs(above.elevation - storeys[index].elevation - topZ) > 1e-3) return null;
  return storeyGlobalId(s, modelId, above.expressId);
}

/** Record a placed element's attachment in the caller's undo batch. Throws when the write is refused. */
export function recordWallTop(s: Pick<ViewerState, 'setProperty'>, modelId: string, elementId: number, attachTo: string): void {
  const written = s.setProperty(modelId, elementId, STOREY_ATTACHMENT_PSET, 'TopConstraint', attachTo, PropertyValueType.Label)
    && s.setProperty(modelId, elementId, STOREY_ATTACHMENT_PSET, TOP_BINDING, RELATIVE_BINDING, PropertyValueType.Label);
  if (!written) throw new Error(`Couldn't record the top of #${elementId}`);
}
