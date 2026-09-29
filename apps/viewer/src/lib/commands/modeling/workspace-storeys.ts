/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storeys the Model workspace can draw on (charter #6232, M2): per
 * editable model, bottom to top, with the live (authored) elevation. The
 * storey chip, its picker and PageUp / PageDown all read this one list.
 */

import type { ViewerState } from '@/store';
import { effectiveStoreyElevation, effectiveStoreyIds } from '@/components/viewer/add-element-storeys';
import { resolveWorkplane } from './registry.js';

export interface WorkspaceStorey {
  readonly modelId: string;
  readonly expressId: number;
  readonly name: string;
  /** Floor height in metres, as authored this session. */
  readonly elevation: number;
}

/** A model's storeys, lowest first. */
export function modelStoreys(s: Pick<ViewerState, 'models' | 'mutationViews'>, modelId: string): WorkspaceStorey[] {
  const store = s.models.get(modelId)?.ifcDataStore;
  if (!store) return [];
  const view = s.mutationViews.get(modelId);
  return effectiveStoreyIds(store, view)
    .map((expressId) => ({
      modelId,
      expressId,
      name: store.entities.getName(expressId) || `#${expressId}`,
      elevation: effectiveStoreyElevation(store, view, expressId),
    }))
    .sort((a, b) => a.elevation - b.elevation || a.expressId - b.expressId);
}

/** Models the workspace can open on: the ones carrying parsed IFC data. */
export function editableModels(s: ViewerState): { id: string; name: string }[] {
  return [...s.models.entries()]
    .filter(([, model]) => model.ifcDataStore != null)
    .map(([id, model]) => ({ id, name: model.name }));
}

/** Move the session one storey up (+1) or down (−1); false at either end. */
export function stepSessionStorey(s: ViewerState, direction: 1 | -1): boolean {
  const session = s.session;
  if (!session) return false;
  const storeys = modelStoreys(s, session.modelId);
  const at = storeys.findIndex((storey) => storey.expressId === session.storeyId);
  const next = storeys[at + direction];
  if (at < 0 || !next) return false;
  s.setSessionStorey(next.expressId);
  return true;
}

/** Why the session cannot draw right now, or null when it can. */
export type WorkplaneBlock = { kind: 'noStorey' } | { kind: 'refused'; reason: string } | null;

export function sessionWorkplaneBlock(s: ViewerState): WorkplaneBlock {
  const session = s.session;
  if (!session?.workplane) return { kind: 'noStorey' };
  const plane = resolveWorkplane(s, session.modelId, session.workplane);
  return 'refused' in plane ? { kind: 'refused', reason: plane.refused } : null;
}
