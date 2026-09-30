/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A store-shaped state for driving the REAL `collabSlice` actions in node
 * tests: the model + data + collab slices composed with a real StoreApi, plus
 * the fields other slices own that the teardown `removeModel` dispatches read
 * (`store/teardown-registry.ts`). Every contribution falls back to its own
 * initial value when a field is absent, so these exist to make the harness
 * store-shaped rather than to satisfy a type.
 *
 * Shared by the collabSlice race tests (`leave-during-join-race`,
 * `entry-race`, `seed-phase`).
 */

import { createStore } from 'zustand/vanilla';
import { createModelSlice, type ModelSlice } from '../store/slices/modelSlice.js';
import { createDataSlice, type DataSlice, type DataCrossSliceState } from '../store/slices/dataSlice.js';
import { createCollabSlice, type CollabSlice } from '../store/slices/collabSlice.js';
import type { ViewerState } from '../store/index.js';
import type { Annotation } from '../store/slices/annotationsSlice.js';
import type { MutablePropertyView } from '@ifc-lite/mutations';

export type CollabTestState = ModelSlice &
  DataSlice &
  DataCrossSliceState &
  CollabSlice & {
    /** uiSlice's; `startCollab` only calls it when `canCollabEdit()` is false. */
    setEditEnabled: (enabled: boolean) => void;
    /** mutationSlice's; `roomMutationView` reads it through `RoomModelTargetState`. */
    mutationViews: Map<string, MutablePropertyView>;
    /** annotationsSlice's; `startCollab` seeds every local pin into the room. */
    annotations: Map<string, Annotation>;
  };

export interface CollabTestHooks {
  /** Observes every store write (before/after), for tracing state transitions. */
  onSet?: (before: CollabTestState, after: CollabTestState) => void;
}

export function buildCollabTestState(hooks: CollabTestHooks = {}) {
  // #6499: metadata observers need the genuine subscription lifecycle;
  // an undefined third slice argument cannot exercise room seeding correctly.
  const store = createStore<CollabTestState>((setState, get, api) => {
    const getState = () => get() as unknown as ViewerState;

    const modelSlice = createModelSlice(
      setState as Parameters<typeof createModelSlice>[0],
      getState as Parameters<typeof createModelSlice>[1],
      api as unknown as Parameters<typeof createModelSlice>[2],
    );
    const dataSlice = createDataSlice(
      setState as Parameters<typeof createDataSlice>[0],
      getState as Parameters<typeof createDataSlice>[1],
      api as unknown as Parameters<typeof createDataSlice>[2],
    );
    const collabSlice = createCollabSlice(
      setState as Parameters<typeof createCollabSlice>[0],
      getState as Parameters<typeof createCollabSlice>[1],
      api as unknown as Parameters<typeof createCollabSlice>[2],
    );

    return {
      ...modelSlice,
      ...dataSlice,
      ...collabSlice,
      // uiSlice's real action is not under test; `startCollab` only calls it
      // when `canCollabEdit()` is false (never for role 'admin'), but it must
      // exist to type-check the call site.
      setEditEnabled: () => {},
      mutationViews: new Map(),
      annotations: new Map(),
      selectedEntityId: null,
      selectedEntityIds: new Set(),
      selectedStoreys: new Set(),
      hiddenEntities: new Set(),
      isolatedEntities: null,
      ghostExceptEntities: null,
      classFilter: null,
      pinboardEntities: new Set(),
      hierarchyBasketSelection: new Set(),
    } as CollabTestState;

  });
  store.subscribe((after, before) => hooks.onSet?.(before, after));

  return {
    get: store.getState,
    set: store.setState,
    hooks,
  };
}
