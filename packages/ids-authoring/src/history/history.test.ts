/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { counterIds, loadCorpus } from '../../test/corpus.js';
import { eq } from '../../test/gate-helpers.js';
import { fromIdsDocument } from '../document/from-ids.js';
import type { StudioOp } from '../ops/types.js';
import { OpApplyError } from '../reducer/apply.js';
import { beginTransaction, canRedo, canUndo, commit, createStudioState, redo, undo, type StudioState } from './history.js';
import { createMemoryPersistenceAdapter, fromPersisted, toPersisted } from './persistence.js';

const ids = counterIds(0x415);

function start(): StudioState {
  const withSpecs = loadCorpus().find((c) => c.ids.specifications.length > 0)!;
  return createStudioState(fromIdsDocument(withSpecs.ids, { newId: ids }));
}

function addSpec(name: string): StudioOp[] {
  const specId = ids();
  return [
    { kind: 'spec.add', opId: ids(), payload: { specId, name, ifcVersions: ['IFC4'] } },
    { kind: 'facet.add', opId: ids(), payload: { specId, section: 'applicability', facetId: ids(), facet: { type: 'entity', name: eq('IfcDoor') } } },
  ];
}

describe('history', () => {
  it('treats a multi-op commit as one undo step and redoes it', () => {
    const s0 = start();
    const s1 = commit(s0, addSpec('Doors'), { label: 'AI proposal', source: { by: 'ai', runId: ids(), model: 'test-model' } }).state;
    const s2 = commit(s1, [{ kind: 'doc.setInfo', opId: ids(), payload: { field: 'purpose', value: 'Design' } }]).state;
    expect(s2.history.past).toHaveLength(2);
    expect(s2.history.past[0]).toMatchObject({ label: 'AI proposal', source: { by: 'ai' } });
    const u1 = undo(s2);
    expect(u1.doc).toEqual(s1.doc);
    const u2 = undo(u1);
    expect(u2.doc).toEqual(s0.doc);
    expect(canUndo(u2)).toBe(false);
    expect(canRedo(u2)).toBe(true);
    const r = redo(redo(u2));
    expect(r.doc).toEqual(s2.doc);
    expect(canRedo(r)).toBe(false);
  });

  it('clears the redo branch on a new commit and caps the history', () => {
    let s = start();
    for (let i = 0; i < 5; i++) s = commit(s, addSpec(`S${i}`), {}, 3).state;
    expect(s.history.past).toHaveLength(3);
    s = undo(s);
    expect(s.history.future).toHaveLength(1);
    s = commit(s, addSpec('new')).state;
    expect(s.history.future).toHaveLength(0);
  });

  it('leaves the state untouched when an op does not apply', () => {
    const s0 = start();
    expect(() => commit(s0, [{ kind: 'spec.remove', opId: ids(), payload: { specId: ids() } }])).toThrow(OpApplyError);
    expect(s0.history.past).toEqual([]);
  });

  it('compound ops undo in one step', () => {
    let s = commit(start(), addSpec('Doors')).state;
    const before = s.doc;
    s = commit(s, [{ kind: 'bulk.retargetEntity', opId: ids(), payload: { from: 'IfcDoor', to: 'IfcWindow' } }]).state;
    expect(s.history.past.at(-1)!.expanded.length).toBeGreaterThan(0);
    expect(undo(s).doc).toEqual(before);
  });
});

describe('transactions', () => {
  it('applies step by step and commits one entry; rollback restores', () => {
    const s0 = start();
    const tx = beginTransaction(s0);
    tx.apply(addSpec('A'));
    tx.apply(addSpec('B'));
    expect(tx.doc.ids.specifications.length).toBe(s0.doc.ids.specifications.length + 2);
    expect(() => tx.apply([{ kind: 'facet.remove', opId: ids(), payload: { facetId: ids() } }])).toThrow(OpApplyError);
    expect(tx.ops).toHaveLength(4);
    const committed = tx.commit({ label: 'paste' });
    expect(committed.history.past).toHaveLength(1);
    expect(committed.doc).toEqual(tx.doc);
    expect(undo(committed).doc).toEqual(s0.doc);
    expect(tx.rollback()).toBe(s0);
  });
});

describe('persistence', () => {
  it('undoes across a reload through a persistence adapter', async () => {
    const adapter = createMemoryPersistenceAdapter();
    const s0 = start();
    const s1 = commit(s0, addSpec('Doors')).state;
    const s2 = commit(s1, [{ kind: 'spec.set', opId: ids(), payload: { specId: s1.doc.ids.specifications[0].id, field: 'description', value: 'changed' } }]).state;
    await adapter.save(toPersisted(s2, '2026-10-08T00:00:00.000Z'));
    expect(await adapter.list()).toEqual([{ docId: s2.doc.docId, title: s2.doc.ids.info.title, savedAt: '2026-10-08T00:00:00.000Z' }]);

    // "Reload": nothing survives but the stored JSON.
    const reloaded = fromPersisted(await adapter.load(s2.doc.docId));
    expect(reloaded).not.toBe(s2);
    expect(reloaded.doc).toEqual(s2.doc);
    expect(undo(reloaded).doc).toEqual(s1.doc);
    expect(undo(undo(reloaded)).doc).toEqual(s0.doc);
    await adapter.remove(s2.doc.docId);
    expect(await adapter.load(s2.doc.docId)).toBeUndefined();
  });

  it('refuses foreign or corrupt records', () => {
    expect(() => fromPersisted({ format: 'something-else' })).toThrow(/not an IDS Studio state/);
    const good = toPersisted(start());
    const corrupt = structuredClone(good);
    corrupt.state.doc.ids.specifications[0].id = 'mismatch';
    expect(() => fromPersisted(corrupt)).toThrow(/inconsistent node index/);
    expect(() => fromPersisted({ ...good, version: 99 })).toThrow(/unsupported/);
  });
});
