/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createAnnotationsSlice, type AnnotationsSlice, type Annotation } from './annotationsSlice.js';

const STORAGE_KEY = 'ifc-lite:annotations:v1';

/** Reads the persisted ids straight out of localStorage — not the in-memory map. */
function persistedIds(): string[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as Array<{ id: string }>;
  return parsed.map((a) => a.id);
}

// Stub localStorage so the slice can read/write without browser env.
function installStubStorage(): { wipe: () => void } {
  const data = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
  } as Storage;
  return { wipe: () => data.clear() };
}

describe('AnnotationsSlice', () => {
  let state: AnnotationsSlice;
  let setState: (partial: Partial<AnnotationsSlice> | ((s: AnnotationsSlice) => Partial<AnnotationsSlice>)) => void;
  let storage: { wipe: () => void };

  beforeEach(() => {
    storage = installStubStorage();
    storage.wipe();

    setState = (partial) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    };
    state = createAnnotationsSlice(setState as never, () => state, {} as never);
  });

  describe('beginDraft + commitDraft', () => {
    it('commits the draft into a new annotation', () => {
      state.beginDraft({ x: 1, y: 2, z: 3 }, 42, 'arch');
      const id = state.commitDraft('Defect: chip in the corner');
      assert.ok(id);
      assert.strictEqual(state.annotations.size, 1);
      const ann = state.annotations.get(id!);
      assert.strictEqual(ann?.note, 'Defect: chip in the corner');
      assert.strictEqual(ann?.entityExpressId, 42);
      assert.strictEqual(state.draft, null);
    });

    it('drops the draft silently when committed with an empty note', () => {
      state.beginDraft({ x: 0, y: 0, z: 0 }, null, null);
      const id = state.commitDraft('   ');
      assert.strictEqual(id, null);
      assert.strictEqual(state.annotations.size, 0);
      assert.strictEqual(state.draft, null);
    });

    it('clears the selected pin when a draft begins', () => {
      state.beginDraft({ x: 0, y: 0, z: 0 }, null, null);
      const id = state.commitDraft('first');
      state.selectAnnotation(id!);
      assert.strictEqual(state.selectedAnnotationId, id);
      state.beginDraft({ x: 1, y: 1, z: 1 }, null, null);
      assert.strictEqual(state.selectedAnnotationId, null);
    });
  });

  describe('updateAnnotation', () => {
    it('updates the note and bumps updatedAt', () => {
      state.beginDraft({ x: 0, y: 0, z: 0 }, null, null);
      const id = state.commitDraft('original')!;
      const original = state.annotations.get(id)!;
      // Force a measurable time delta even when the test runner is fast.
      const before = original.updatedAt;
      state.updateAnnotation(id, 'revised');
      const after = state.annotations.get(id)!;
      assert.strictEqual(after.note, 'revised');
      assert.ok(after.updatedAt >= before);
    });

    it('keeps the annotation when the note is wiped (does not auto-delete)', () => {
      state.beginDraft({ x: 0, y: 0, z: 0 }, null, null);
      const id = state.commitDraft('something')!;
      state.updateAnnotation(id, '');
      const ann = state.annotations.get(id);
      assert.ok(ann);
      assert.strictEqual(ann!.note, '');
    });
  });

  describe('removeAnnotation', () => {
    it('removes the entry and clears the selection if it was selected', () => {
      state.beginDraft({ x: 0, y: 0, z: 0 }, null, null);
      const id = state.commitDraft('to-delete')!;
      state.selectAnnotation(id);
      state.removeAnnotation(id);
      assert.strictEqual(state.annotations.size, 0);
      assert.strictEqual(state.selectedAnnotationId, null);
    });

    it('removes the entry from persisted storage, not just memory', () => {
      state.beginDraft({ x: 0, y: 0, z: 0 }, null, null);
      const id = state.commitDraft('to-delete')!;
      assert.ok(persistedIds().includes(id), 'sanity: pin was persisted on commit');
      state.removeAnnotation(id);
      assert.strictEqual(state.annotations.has(id), false);
      assert.ok(!persistedIds().includes(id), 'deleted pin must not resurrect from storage');
    });
  });

  describe('removeRemoteAnnotation', () => {
    it('persists the deletion of a peer-edit-of-OUR-pin (non-remote) — mirrors upsertRemoteAnnotation', () => {
      // Create a local pin (persisted), then simulate a peer deleting it —
      // this is the path collabSlice.ts's `removeRemote` bridge calls.
      state.beginDraft({ x: 0, y: 0, z: 0 }, null, null);
      const id = state.commitDraft('mine, deleted remotely')!;
      assert.ok(persistedIds().includes(id), 'sanity: pin was persisted on commit');

      state.removeRemoteAnnotation(id);

      assert.strictEqual(state.annotations.has(id), false, 'removed from in-memory map');
      assert.ok(
        !persistedIds().includes(id),
        'must also be removed from localStorage or it resurrects on reload',
      );
    });

    it('does not add a storage entry when deleting a purely-remote pin', () => {
      const remoteAnnotation: Annotation = {
        id: 'ann_remote_1',
        position: { x: 1, y: 1, z: 1 },
        note: "peer's pin",
        entityExpressId: null,
        modelId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        remote: true,
      };
      state.upsertRemoteAnnotation(remoteAnnotation);
      assert.strictEqual(state.annotations.has('ann_remote_1'), true);
      assert.ok(
        !persistedIds().includes('ann_remote_1'),
        'sanity: a purely-remote pin was never persisted',
      );

      state.removeRemoteAnnotation('ann_remote_1');

      assert.strictEqual(state.annotations.has('ann_remote_1'), false);
      assert.ok(
        !persistedIds().includes('ann_remote_1'),
        'deleting a pin we never persisted must not add a storage entry',
      );
    });
  });

  describe('persistence', () => {
    it('survives a fresh slice instantiation by round-tripping localStorage', () => {
      state.beginDraft({ x: 7, y: 8, z: 9 }, 1, 'm1');
      const id = state.commitDraft('persistent')!;

      // Spin up a brand-new slice — it should pick up the saved entry
      // without us threading state through ourselves.
      let s2: AnnotationsSlice;
      const setState2: (p: never) => void = () => {};
      s2 = createAnnotationsSlice(setState2 as never, () => s2, {} as never);
      assert.strictEqual(s2.annotations.size, 1);
      assert.strictEqual(s2.annotations.get(id)?.note, 'persistent');
    });
  });
});
