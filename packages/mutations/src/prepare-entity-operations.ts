/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreEditor } from './store-editor.js';
import type { MutablePropertyView } from './mutable-property-view.js';
import type { MutationStoreShape, Mutation } from './types.js';
import { CooperativeControl } from './cooperative-control.js';
import { cloneCooperatively } from './cooperative-clone.js';
import { cooperativeOverlay, type OverlaySnapshot } from './cooperative-overlay-access.js';
import { sameOverlayValue } from './overlay-value-equality.js';
import { executeEntityOperation } from './execute-entity-operation.js';
import type { EntityOperation, EntityOperationEffect, EntityPreparationOptions, PreparedEntityOperations } from './cooperative-operation-types.js';

/** Package-private composition; the public owner is StoreEditor. */
export async function prepareEntityOperations(
  store: MutationStoreShape, view: MutablePropertyView,
  operations: readonly EntityOperation[], options: EntityPreparationOptions,
  createEditor: (draft: MutablePropertyView) => StoreEditor,
): Promise<PreparedEntityOperations> {
  const control = new CooperativeControl(options);
  let live: ReturnType<typeof cooperativeOverlay> | undefined = cooperativeOverlay(view);
  let operationSource: readonly EntityOperation[] | undefined = operations;
  let sourceStore: MutationStoreShape | undefined = store;
  let original: OverlaySnapshot | undefined;
  let prepared: OverlaySnapshot | undefined;
  let publication: OverlaySnapshot | undefined;
  let input: readonly EntityOperation[] | undefined;
  let disposed = false, committed = false, rolledBack = false;
  let sourceIndex: MutationStoreShape['entityIndex']['byId'] | undefined = store.entityIndex.byId;
  const sourceCount = sourceIndex.size;
  let deferredIndex = store.deferredEntityIndex;
  const deferredCount = deferredIndex?.size;
  const clear = () => {
    original = undefined; prepared = undefined; publication = undefined; input = undefined;
    operationSource = undefined; sourceStore = undefined; sourceIndex = undefined; deferredIndex = undefined; live = undefined;
  };
  const assertAvailable = () => {
    if (disposed) throw new Error('Prepared entity operations were disposed.');
    if (rolledBack) throw new Error('Prepared entity operations were rolled back.');
  };
  const validate = () => {
    assertAvailable();
    if (committed) return;
    control.checkAbort();
    if (!sourceStore || sourceStore.entityIndex.byId !== sourceIndex || sourceIndex?.size !== sourceCount
      || sourceStore.deferredEntityIndex !== deferredIndex || deferredIndex?.size !== deferredCount) {
      throw new Error('The IFC source index changed during entity preparation.');
    }
    if (!input || !sameOverlayValue(operationSource, input)) throw new Error('Entity operation inputs changed during preparation.');
    if (!original || !live!.matches(original)) throw new Error('The IFC overlay changed during entity preparation.');
  };
  try {
    if (!Array.isArray(operations) || !operations.length) throw new TypeError('Entity preparation requires a nonempty operation list.');
    input = await cloneCooperatively(operations, control);
    original = await cloneCooperatively(live!.capture(), control);
    // All draft inputs are now private. No asynchronous callback receives them.
    const draft = live!.draft(await cloneCooperatively(original, control));
    const editor = createEditor(draft);
    const oldHistory = new Set<string>();
    for (const mutation of original.mutationHistory) {
      oldHistory.add(mutation.id);
      if (control.step(48)) await control.pause();
    }
    const effects: EntityOperationEffect[] = [];
    for (const operation of input) {
      effects.push(executeEntityOperation(editor, draft, operation));
      if (control.step(64)) await control.pause();
    }
    prepared = await cloneCooperatively(cooperativeOverlay(draft).capture(), control);
    publication = await cloneCooperatively(prepared, control);
    const changes: Mutation[] = [];
    for (const mutation of prepared.mutationHistory) {
      if (!oldHistory.has(mutation.id)) changes.push(mutation);
      if (control.step(16)) await control.pause();
    }
    // The result must not provide a path back to private checkpoints/publication.
    const detached = await cloneCooperatively({ effects, mutations: changes }, control);
    validate();
    return {
      effects: detached.effects, mutations: detached.mutations, validate,
      commit() {
        assertAvailable();
        if (committed) return;
        validate();
        live!.publish(publication!);
        publication = undefined;
        committed = true;
        operationSource = undefined; input = undefined;
      },
      rollback() {
        if (!committed || rolledBack) return;
        if (disposed) throw new Error('Prepared entity operations were disposed.');
        if (!prepared || !live!.matches(prepared)) throw new Error('The IFC overlay changed after entity operations committed.');
        live!.publish(original!);
        rolledBack = true;
        clear();
      },
      dispose() { if (disposed) return; disposed = true; clear(); },
    };
  } catch (error) {
    clear();
    throw error;
  }
}
