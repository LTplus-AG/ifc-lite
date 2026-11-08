/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which storey the modelling session draws on (#9013). Kept apart from
 * `storey-actions.ts` so the storey chip can switch storeys without loading
 * the storey planner into the boot bundle.
 */

import type { ViewerState } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { applyLevelDisplayMode } from '@/store/levelDisplay';

/** The storey is isolated (Solo) in the level display. */
export function isStoreyIsolated(s: ViewerState, modelId: string, storeyId: number): boolean {
  return s.levelDisplayMode === 'solo' && s.selectedStoreys.has(toGlobalIdFromModels(s.models, modelId, storeyId));
}

/** Move the session to another storey of its model; an isolated storey hands its isolation on. */
export function switchSessionStorey(s: ViewerState, storeyId: number): void {
  const session = s.session;
  if (!session || session.storeyId === storeyId) return;
  const isolated = session.storeyId !== null && isStoreyIsolated(s, session.modelId, session.storeyId);
  s.setSessionStorey(storeyId);
  if (isolated) applyLevelDisplayMode('solo', [{ modelId: session.modelId, expressId: storeyId }]);
}

/**
 * Make `storeyId` the storey the session draws on (workplane, plan and tools
 * follow), keeping the command and the isolation: the chip, the plan header
 * and the storey manager all switch storeys here.
 */
export function activateStorey(s: ViewerState, modelId: string, storeyId: number): void {
  const session = s.session;
  if (!session) return;
  if (session.modelId === modelId) { switchSessionStorey(s, storeyId); return; }
  const isolated = session.storeyId !== null && isStoreyIsolated(s, session.modelId, session.storeyId);
  const command = session.activeCommandId ?? undefined;
  s.exitModelWorkspace();
  s.enterModelWorkspace({ modelId, storeyId, command });
  if (isolated) applyLevelDisplayMode('solo', [{ modelId, expressId: storeyId }]);
}

/**
 * A deleted storey cannot stay isolated: the isolation moves to the storey the
 * session draws on, or the model shows every storey again.
 */
export function releaseDeletedIsolation(s: ViewerState, modelId: string, storeyId: number): void {
  if (!isStoreyIsolated(s, modelId, storeyId)) return;
  const session = s.session;
  if (session?.modelId === modelId && session.storeyId !== null && session.storeyId !== storeyId) {
    applyLevelDisplayMode('solo', [{ modelId, expressId: session.storeyId }]);
  } else {
    applyLevelDisplayMode('stacked');
  }
}
