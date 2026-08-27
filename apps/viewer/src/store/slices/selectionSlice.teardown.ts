/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `selectionSlice`'s contribution to the store-wide teardown seam
 * (`store/teardown.ts`). Split out beside the slice for the reason
 * `modelSlice.teardown.ts` documents.
 *
 * Selection holds BOTH keying schemes the teardown paths distinguish, which is
 * why it is the file where the two purge shapes are most visible:
 *
 *  - `EntityRef`-keyed state (`selectedEntity`, `activeStorey`,
 *    `selectedEntities`, `selectedEntitiesSet`, `selectedModelId`) carries the
 *    owning model, so a removal filters it on `modelId`.
 *  - global-id state (`selectedEntityId`, `selectedEntityIds`,
 *    `selectedStoreys`) does not, so a removal filters it on the scope's
 *    `isStale` — "no SURVIVING model owns this id".
 *
 * `clearSelection` / `clearEntitySelection` / `clearStoreySelection` stay as
 * they are: they are narrower user-facing actions, not teardown, and routing
 * teardown through them would drag their side conditions along.
 */

import { defineSliceTeardown } from '../teardown.js';
import { stringToEntityRef } from '../types.js';

export const selectionTeardown = defineSliceTeardown(
  'selectionSlice',
  [
    'selectedEntityId',
    'selectedEntityIds',
    'selectedStoreys',
    'activeStorey',
    'selectedEntity',
    'selectedEntitiesSet',
    'selectedEntities',
    'selectedModelId',
  ],
  (scope, state) => {
    if (scope.kind === 'session-reset') {
      return {
        // Selection (legacy)
        selectedEntityId: null,
        selectedEntityIds: new Set<number>(),
        selectedStoreys: new Set<number>(),
        // Drop the shared active storey — it references the outgoing model, so
        // a new file must not inherit a stale storey for Solo / Space Sketch.
        activeStorey: null,

        // Selection (multi-model)
        selectedEntity: null,
        selectedEntitiesSet: new Set<string>(),
        selectedEntities: [],
        selectedModelId: null,
      };
    }

    if (scope.kind === 'all-models-cleared') {
      // Only the global-id half, which is what `clearAllModels` has always
      // written. The `EntityRef`-keyed half is deliberately absent: adding it
      // here would be a behaviour change, not a restructuring, and this
      // refactor is not the place to make one. (It is a real asymmetry —
      // `resetViewerState` clears both halves — and is called out as a
      // follow-up rather than smuggled in.)
      return {
        selectedEntityId: null,
        selectedEntityIds: new Set<number>(),
        selectedStoreys: new Set<number>(),
      };
    }

    const { modelId, isStale } = scope;

    // ── EntityRef-keyed half ────────────────────────────────────────────────
    // Selection state keys off modelId, so anything pointing at the removed
    // model is now dangling: `models.get(selectedEntity.modelId)` returns
    // undefined and the properties panel silently renders nothing rather than
    // re-resolving, leaving a ghost selection until the user clicks elsewhere.
    // `activeStorey` likewise stays pinned to a storey in a model that no
    // longer exists, which the Solo level display and floorplan read. Entries
    // belonging to OTHER models are preserved — clearing wholesale would drop
    // a federated sibling's live selection.
    //
    // Every read falls back to this slice's OWN initial value: a teardown is
    // handed `Readonly<Partial<ViewerState>>` because `slices/modelSlice.test.ts`
    // drives this composition against a state where other slices are absent.
    const priorEntities = state.selectedEntities ?? [];
    const priorSet = state.selectedEntitiesSet ?? new Set<string>();
    const keptEntities = priorEntities.filter((e) => e.modelId !== modelId);
    const refsTouched =
      state.selectedEntity?.modelId === modelId ||
      state.activeStorey?.modelId === modelId ||
      keptEntities.length !== priorEntities.length ||
      // `selectedModelId` on its own is enough. `removeModel` used to gate it
      // behind the entity-ref checks above, so a model selected in the
      // hierarchy but with no entity selected under it kept a dangling id;
      // the resync purge already cleared it unconditionally on the
      // resync path. One implementation now, so it takes the purge's reading.
      state.selectedModelId === modelId;

    // ── Global-id half ──────────────────────────────────────────────────────
    // These key off `globalId`, not `modelId` — they don't carry which model an
    // id belongs to the way the `EntityRef`-shaped state above does. A global
    // id is "stale" once no SURVIVING model's parse range or overlay owns it,
    // which is exactly the predicate the scope carries.
    const priorSelectedEntityIds = state.selectedEntityIds;
    const priorSelectedStoreys = state.selectedStoreys;
    const priorSelectedEntityId = state.selectedEntityId;
    const idsTouched =
      (priorSelectedEntityIds !== undefined && [...priorSelectedEntityIds].some(isStale)) ||
      (priorSelectedStoreys !== undefined && [...priorSelectedStoreys].some(isStale)) ||
      (priorSelectedEntityId != null && isStale(priorSelectedEntityId));

    return {
      ...(refsTouched
        ? {
            selectedEntity:
              state.selectedEntity?.modelId === modelId ? null : state.selectedEntity,
            activeStorey: state.activeStorey?.modelId === modelId ? null : state.activeStorey,
            selectedEntities: keptEntities,
            // Parsed with the shared helper rather than a `${modelId}:` prefix
            // test: `stringToEntityRef` splits on the FIRST colon, so a prefix
            // match would also strip a sibling model whose id merely starts
            // with this one's id plus a colon. Using the same parse every other
            // consumer uses keeps this filter from becoming a third, subtly
            // different reading of the same key.
            selectedEntitiesSet: new Set(
              [...priorSet].filter((k) => stringToEntityRef(k).modelId !== modelId),
            ),
            selectedModelId:
              state.selectedModelId === modelId ? null : state.selectedModelId,
          }
        : {}),
      ...(idsTouched
        ? {
            selectedEntityId:
              priorSelectedEntityId != null && isStale(priorSelectedEntityId)
                ? null
                : priorSelectedEntityId,
            selectedEntityIds: priorSelectedEntityIds
              ? new Set([...priorSelectedEntityIds].filter((id) => !isStale(id)))
              : priorSelectedEntityIds,
            selectedStoreys: priorSelectedStoreys
              ? new Set([...priorSelectedStoreys].filter((id) => !isStale(id)))
              : priorSelectedStoreys,
          }
        : {}),
    };
  },
);
