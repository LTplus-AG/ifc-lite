/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readWallJoinTarget, type WallAutojoinIndex } from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { AuthoredElement } from '@/store/slices/authoredElement';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { rememberRemesh } from '@/lib/remesh/remesh-registry';
import type { StoreApi } from './types.js';

/** The core remembers successful joins inside the unpublished creation draft.
 * Observe those exact writes instead of walking the model after each add. */
export function trackImplicitWallJoins(editor: StoreEditor, index: WallAutojoinIndex) {
  const changed = new Set<number>();
  let newWallId: number | undefined;
  let captureBeforeRewrite: (() => void) | undefined;
  let rewrites = false;
  return {
    prepareHistory: (capture: () => void) => { captureBeforeRewrite = capture; },
    index: {
      candidates: wall => { newWallId = wall.wallId; return index.candidates(wall); },
      remember: wall => {
        // The live editor still sees the pre-commit model. Only a neighbour
        // exists there; the new wall is confined to the creation draft.
        if (wall.wallId !== newWallId && editor.hasEntity(wall.wallId)) {
          captureBeforeRewrite?.();
          rewrites = true;
        }
        changed.add(wall.wallId);
        index.remember(wall);
      },
    } satisfies WallAutojoinIndex,
    complete(store: StoreApi, modelId: string, dataStore: IfcDataStore, storeyId: number, newId: number, element: AuthoredElement): void {
      const book = (id: number, authored: AuthoredElement) => store.getState().recordAuthoredElement?.(
        modelId, storeyId, id, authored, { historyRecorded: true },
      );
      if (!rewrites) {
        book(newId, element);
        return;
      }
      const scale = getModelLengthUnitScale(dataStore);
      for (const id of changed) {
        // Endpoint summaries deliberately avoid body reads for unjoined adds.
        // Only actual joins need complete, committed authored geometry here.
        const target = readWallJoinTarget(dataStore, editor.getMutationView(), id, scale);
        if (!target) throw new Error(`Joined wall #${id} has unreadable authored geometry`);
        const wall = target.wall, z = target.location[2] * scale;
        book(target.wallId, { kind: 'wall', params: {
          Start: [wall.start[0], wall.start[1], z], End: [wall.end[0], wall.end[1], z],
          Thickness: wall.thickness, Height: target.height, Alignment: wall.alignment,
          Offset: wall.offset, StartCut: wall.startCut, EndCut: wall.endCut,
        } });
      }
      // Authored bookkeeping requested both meshes. Keep the same changed set
      // on this commit's undo batch so Undo/Redo also remesh the neighbour.
      const state = store.getState(), last = state.undoStacks.get(modelId)?.at(-1);
      const batch = last ? state.mutationBatchTags.get(last.id) : undefined;
      if (batch) rememberRemesh(store.getState, batch, modelId, [...changed], 'shape');
    },
  };
}
