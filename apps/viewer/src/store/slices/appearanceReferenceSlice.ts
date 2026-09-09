/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StateCreator } from 'zustand';
import type { ViewerState } from '../index.js';
import { defineSliceTeardown } from '../teardown.js';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { createReferenceLeases } from '@/lib/appearance/references/leases.js';
import { parseReferences, serializeReferences } from '@/lib/appearance/references/persistence.js';
import { MAX_REFERENCES, MAX_REFERENCE_HISTORY, ownReference,
  type RegisteredAppearanceReference, type ReferenceCommand } from '@/lib/appearance/references/types.js';

export interface AppearanceReferenceSlice {
  appearanceReferences: ReadonlyMap<string, RegisteredAppearanceReference>;
  referenceUndo: readonly ReferenceCommand[];
  referenceRedo: readonly ReferenceCommand[];
  referenceRevision: number;
  selectedAppearanceReferenceId: string | null;
  selectAppearanceReference(id: string | null): void;
  addAppearanceReference(record: RegisteredAppearanceReference): void;
  replaceAppearanceReference(id: string, record: RegisteredAppearanceReference): void;
  updateAppearanceReference(id: string, patch: Partial<Omit<RegisteredAppearanceReference, 'id' | 'sourceId' | 'assetId'>>): void;
  removeAppearanceReference(id: string): void;
  replayAppearanceReference(direction: 'undo' | 'redo'): void;
  exportAppearanceReferences(): string;
  importAppearanceReferences(text: string): void;
  /** Restores bytes only when their content digest exactly matches the saved record. */
  relinkAppearanceReference(id: string, image: File, signal?: AbortSignal): Promise<void>;
}
export const createAppearanceReferenceSlice: StateCreator<ViewerState, [], [], AppearanceReferenceSlice> = (set, get, api) => {
  const leases = createReferenceLeases();
  api.subscribe((state, previous) => {
    if (state.appearanceReferences !== previous.appearanceReferences || state.referenceUndo !== previous.referenceUndo
      || state.referenceRedo !== previous.referenceRedo) leases.sync(state);
  });
  function publish(records: ReadonlyMap<string, RegisteredAppearanceReference>): void {
    const before = get();
    const command: ReferenceCommand = Object.freeze({ id: crypto.randomUUID(), timestamp: Date.now(),
      before: before.appearanceReferences, after: records });
    const patch = { appearanceReferences: records,
      referenceUndo: [...before.referenceUndo, command].slice(-MAX_REFERENCE_HISTORY), referenceRedo: [],
      referenceRevision: before.referenceRevision + 1,
      selectedAppearanceReferenceId: before.selectedAppearanceReferenceId && records.has(before.selectedAppearanceReferenceId)
        ? before.selectedAppearanceReferenceId : null };
    leases.sync(patch);
    set(patch);
  }
  function required(id: string): RegisteredAppearanceReference {
    const record = get().appearanceReferences.get(id);
    if (!record) throw new Error('The drawing reference was removed.');
    return record;
  }
  return {
    appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [], referenceRevision: 0, selectedAppearanceReferenceId: null,
    selectAppearanceReference(id) { if (id !== null) required(id); set({ selectedAppearanceReferenceId: id }); },
    addAppearanceReference(input) {
      const record = ownReference(input), state = get();
      if (record.frameKey !== placementFrameKey(state)) throw new Error('The drawing reference coordinate frame differs from this workspace.');
      if (!appearanceAssets.get(record.assetId)) throw new Error('The drawing image is unavailable. Relink its original image first.');
      if (state.appearanceReferences.has(record.id)) throw new Error('The drawing reference already exists.');
      if (state.appearanceReferences.size >= MAX_REFERENCES) throw new Error('The workspace drawing reference limit was reached.');
      publish(new Map(state.appearanceReferences).set(record.id, record));
    },
    replaceAppearanceReference(id, input) {
      if (required(id).locked) throw new Error('Unlock the drawing reference before replacing it.');
      const record = ownReference(input);
      if (record.id !== id) throw new Error('A replacement must keep the drawing reference identifier.');
      if (record.frameKey !== placementFrameKey(get())) throw new Error('The drawing reference coordinate frame differs from this workspace.');
      if (!appearanceAssets.get(record.assetId)) throw new Error('The replacement drawing image is unavailable.');
      publish(new Map(get().appearanceReferences).set(id, record));
    },
    updateAppearanceReference(id, patch) {
      const before = required(id);
      // Unlock is deliberate and separate; a locked registration cannot move,
      // change opacity, visibility or frame as a side effect of another edit.
      if (before.locked && (Object.keys(patch).length !== 1 || patch.locked !== false)) {
        throw new Error('Unlock the drawing reference before changing it.');
      }
      const record = ownReference({ ...before, ...patch, id, sourceId: before.sourceId, assetId: before.assetId });
      const unlocking = before.locked && patch.locked === false && Object.keys(patch).length === 1;
      if (record.frameKey !== placementFrameKey(get()) && !unlocking) throw new Error('The drawing reference coordinate frame differs from this workspace.');
      publish(new Map(get().appearanceReferences).set(id, record));
    },
    removeAppearanceReference(id) {
      if (required(id).locked) throw new Error('Unlock the drawing reference before removing it.');
      const records = new Map(get().appearanceReferences); records.delete(id); publish(records);
    },
    replayAppearanceReference(direction) {
      const state = get(), command = (direction === 'undo' ? state.referenceUndo : state.referenceRedo).at(-1);
      if (!command) return;
      const records = direction === 'undo' ? command.before : command.after;
      if ([...records.values()].some(record => record.frameKey !== placementFrameKey(state))) {
        throw new Error('The drawing reference coordinate frame changed. Re-register it before replaying history.');
      }
      const patch = { appearanceReferences: records,
        referenceUndo: direction === 'undo' ? state.referenceUndo.slice(0, -1) : [...state.referenceUndo, command],
        referenceRedo: direction === 'redo' ? state.referenceRedo.slice(0, -1) : [...state.referenceRedo, command],
        referenceRevision: state.referenceRevision + 1,
        selectedAppearanceReferenceId: state.selectedAppearanceReferenceId && records.has(state.selectedAppearanceReferenceId)
          ? state.selectedAppearanceReferenceId : null };
      leases.sync(patch); set(patch);
    },
    exportAppearanceReferences: () => serializeReferences(get().appearanceReferences, placementFrameKey(get())),
    importAppearanceReferences(text) {
      const records = parseReferences(text, placementFrameKey(get()));
      // Import replaces registrations atomically, but never silently moves or
      // deletes a locked reference. Missing assets remain in the restored list.
      for (const [id, record] of get().appearanceReferences) if (record.locked
        && JSON.stringify(records.get(id)) !== JSON.stringify(record)) {
        throw new Error('Unlock existing drawing references before replacing their registration.');
      }
      publish(records);
    },
    async relinkAppearanceReference(id, image, signal) {
      const before = required(id), owner = { kind: 'draft' as const, id: `reference-relink:${crypto.randomUUID()}` };
      try {
        const asset = await appearanceAssets.add(image, { owner, signal });
        if (signal?.aborted) throw new DOMException('Image relinking cancelled.', 'AbortError');
        if (asset.id !== before.assetId) throw new Error('This image does not match the drawing registration. Choose the original image bytes.');
        if (get().appearanceReferences.get(id) !== before) throw new Error('The drawing reference changed while its image was loading.');
        leases.sync(get());
        set(state => ({ referenceRevision: state.referenceRevision + 1 }));
      } finally { appearanceAssets.releaseOwner(owner); }
    },
  };
};

export const appearanceReferenceTeardown = defineSliceTeardown('appearanceReferenceSlice',
  ['appearanceReferences', 'referenceUndo', 'referenceRedo', 'referenceRevision', 'selectedAppearanceReferenceId'], {
    'model-removed': () => ({}),
    'session-reset': () => ({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [], referenceRevision: 0, selectedAppearanceReferenceId: null }),
    // Georeferencing reloads clear IFC models without resetting the workspace.
    // Reference identities contain no IFC IDs; keep registrations and their leases.
    'all-models-cleared': () => ({}),
  });
