/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A store-shaped state for driving the REAL `collabSlice` actions in node
 * tests: the model + data + collab slices composed over a plain object, plus
 * the fields other slices own that the teardown `removeModel` dispatches read
 * (`store/teardown-registry.ts`). Every contribution falls back to its own
 * initial value when a field is absent, so these exist to make the harness
 * store-shaped rather than to satisfy a type.
 *
 * One copy of what `collabSlice.leave-during-join-race.test.ts` and
 * `collabSlice.entry-race.test.ts` each spell out inline; keep those in step
 * with this when the enumeration changes.
 */

import { createModelSlice, type ModelSlice } from '../store/slices/modelSlice.js';
import { createDataSlice, type DataSlice, type DataCrossSliceState } from '../store/slices/dataSlice.js';
import { createCollabSlice, type CollabSlice } from '../store/slices/collabSlice.js';
import type { ViewerState } from '../store/index.js';

export type CollabTestState = ModelSlice &
  DataSlice &
  DataCrossSliceState &
  CollabSlice & {
    setEditEnabled: (enabled: boolean) => void;
    mutationViews: Map<string, unknown>;
  };

export interface CollabTestHooks {
  /** Observes every store write (before/after), for tracing state transitions. */
  onSet?: (before: CollabTestState, after: CollabTestState) => void;
}

export function buildCollabTestState(hooks: CollabTestHooks = {}) {
  let state: CollabTestState;
  const setState = (partial: unknown) => {
    const updates =
      typeof partial === 'function'
        ? (partial as (s: CollabTestState) => Partial<CollabTestState>)(state)
        : (partial as Partial<CollabTestState>);
    const before = state;
    state = { ...state, ...updates };
    hooks.onSet?.(before, state);
  };
  const getState = () => state as unknown as ViewerState;

  const modelSlice = createModelSlice(
    setState as Parameters<typeof createModelSlice>[0],
    getState as Parameters<typeof createModelSlice>[1],
    undefined as unknown as Parameters<typeof createModelSlice>[2],
  );
  const dataSlice = createDataSlice(
    setState as Parameters<typeof createDataSlice>[0],
    getState as Parameters<typeof createDataSlice>[1],
    undefined as unknown as Parameters<typeof createDataSlice>[2],
  );
  const collabSlice = createCollabSlice(
    setState as Parameters<typeof createCollabSlice>[0],
    getState as Parameters<typeof createCollabSlice>[1],
    undefined as unknown as Parameters<typeof createCollabSlice>[2],
  );

  state = {
    ...modelSlice,
    ...dataSlice,
    ...collabSlice,
    // uiSlice's real action is not under test; `startCollab` only calls it
    // when `canCollabEdit()` is false (never for role 'admin'), but it must
    // exist to type-check the call site.
    setEditEnabled: () => {},
    mutationViews: new Map(),
    addElementModelId: null,
    addElementStoreyId: null,
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    selectedStoreys: new Set(),
    hiddenEntities: new Set(),
    isolatedEntities: null,
    ghostExceptEntities: null,
    classFilter: null,
    hiddenEntitiesByModel: new Map(),
    isolatedEntitiesByModel: new Map(),
    pinboardEntities: new Set(),
    hierarchyBasketSelection: new Set(),
  } as CollabTestState;

  return {
    get: () => state,
    set: (partial: Partial<CollabTestState>) => setState(partial),
    hooks,
  };
}
