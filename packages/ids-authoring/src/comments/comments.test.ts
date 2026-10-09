/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Comments in the sidecar (IDS-108): ops, undo, gate, persistence, merge, view model. */

import { describe, expect, it } from 'vitest';
import { counterIds } from '../../test/corpus.js';
import { corpusDocument } from '../../test/mutate.js';
import { checkOps } from '../gate/check.js';
import { createGateContext } from '../gate/context.js';
import { commit, createStudioState, undo } from '../history/history.js';
import { mergeDocuments } from '../merge/merge.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { attachSidecar, createSidecar, parseSidecar, serializeSidecar } from '../sidecar/sidecar.js';
import { commentThreads, extractMentions } from './view.js';

const ids = counterIds(0xc0e);
const op = <K extends PrimitiveOp['kind']>(kind: K, payload: Extract<PrimitiveOp, { kind: K }>['payload']): StudioOp =>
  ({ kind, opId: ids(), payload }) as StudioOp;

const AT = '2026-10-08T09:00:00Z';

function setup() {
  const doc = corpusDocument(12, 3);
  const spec = doc.ids.specifications[0];
  const req = spec.requirements[0];
  const threadId = ids();
  const opened = apply(doc, [
    op('meta.comment.add', { nodeId: req.id, threadId, author: 'Ana', at: AT, text: 'Is this the right pset, @Ben?' }),
    op('meta.comment.reply', { threadId, author: 'Ben', at: AT, text: 'Yes. Ask @"Carla Diaz" (carla@example.com) for the value.' }),
  ]).doc;
  return { doc, opened, spec, req, threadId };
}

describe('comment ops', () => {
  it('open, reply, resolve and undo as one transaction', () => {
    const { doc, req } = setup();
    const threadId = ids();
    let state = createStudioState(doc);
    state = commit(state, [
      op('meta.comment.add', { nodeId: req.id, threadId, author: 'Ana', at: AT, text: 'Check the unit' }),
      op('meta.comment.reply', { threadId, author: 'Ben', at: AT, text: 'Done' }),
      op('meta.comment.resolve', { threadId, resolved: true }),
    ]).state;
    expect(state.doc.meta.comments[req.id]).toEqual([
      { id: threadId, resolved: true, comments: [{ author: 'Ana', at: AT, text: 'Check the unit' }, { author: 'Ben', at: AT, text: 'Done' }] },
    ]);
    // Comments never touch IDS content.
    expect(state.doc.ids).toBe(doc.ids);
    expect(undo(state).doc).toEqual(doc);
  });

  it('refuses a thread on an unknown node, and a second opening comment removal', async () => {
    const ctx = await createGateContext();
    const { opened, threadId } = setup();
    const bad = checkOps([op('meta.comment.add', { nodeId: ids(), threadId: ids(), author: 'Ana', at: AT, text: 'x' })], opened, ctx);
    expect(bad.issues.map((i) => i.code)).toEqual(['GATE-STR-001']);
    const removeTwice = checkOps([op('meta.comment.removeReply', { threadId }), op('meta.comment.removeReply', { threadId })], opened, ctx);
    expect(removeTwice.issues.map((i) => [i.opIndex, i.code])).toEqual([[1, 'GATE-STR-006']]);
    expect(checkOps([op('meta.comment.add', { nodeId: opened.nodes.document, threadId: ids(), author: 'Ana', at: AT, text: '' })], opened, ctx).issues[0].code).toBe('GATE-OP-001');
  });

  it('keeps a thread when its node is removed, and re-anchors it on undo', () => {
    const { opened, spec, req } = setup();
    let state = createStudioState(opened);
    state = commit(state, [op('spec.remove', { specId: spec.id })]).state;
    const orphaned = commentThreads(state.doc);
    expect(orphaned.threads[0]).toMatchObject({ nodeId: req.id, orphan: true, anchor: { kind: 'missing' } });
    const back = commentThreads(undo(state).doc);
    expect(back.threads[0]).toMatchObject({ orphan: false, anchor: { kind: 'requirement', specName: spec.name } });
  });

  it('persists in studio.json and survives a re-identified import', () => {
    const { opened, req } = setup();
    const sidecar = parseSidecar(serializeSidecar(createSidecar(opened)));
    const exact = attachSidecar(opened.ids, sidecar);
    expect(exact.doc.meta.comments).toEqual(opened.meta.comments);
    expect(commentThreads(exact.doc).threads[0].anchor.kind).toBe('requirement');
    expect(Object.keys(exact.doc.meta.comments)).toEqual([req.id]);
  });
});

describe('comment view model', () => {
  it('lists threads with anchors, participants, mentions and badges', () => {
    const { opened, req, spec } = setup();
    const view = commentThreads(opened);
    expect(view.unresolved).toBe(1);
    expect(view.badges).toEqual({ [req.id]: 1 });
    expect(view.threads[0]).toMatchObject({
      anchor: { kind: 'requirement', specName: spec.name },
      participants: ['Ana', 'Ben'],
      resolved: false,
    });
    expect(view.threads[0].comments.map((c) => c.mentions)).toEqual([['Ben'], ['Carla Diaz']]);
  });

  it('extracts names, never e-mail addresses', () => {
    expect(extractMentions('@Ana and @Ben-Ole. Mail ana@example.com or (@Zoë)')).toEqual(['Ana', 'Ben-Ole', 'Zoë']);
    expect(extractMentions('no mentions here, x@y.z')).toEqual([]);
  });
});

describe('comments in a merge', () => {
  it('merges discussion additively: new threads, replies and resolution from both sides', () => {
    const { opened, spec, threadId } = setup();
    const newThread = ids();
    const ours = apply(opened, [
      op('meta.comment.add', { nodeId: spec.id, threadId: newThread, author: 'Ana', at: AT, text: 'Rename this spec?' }),
      op('meta.comment.reply', { threadId, author: 'Ana', at: AT, text: 'Thanks' }),
    ]).doc;
    const theirs = apply(opened, [
      op('meta.comment.reply', { threadId, author: 'Carla Diaz', at: AT, text: 'EI60' }),
      op('meta.comment.resolve', { threadId, resolved: true }),
    ]).doc;
    const r = mergeDocuments(opened, ours, theirs);
    expect(r.conflicts).toEqual([]);
    const thread = Object.values(r.doc.meta.comments).flat().find((t) => t.id === threadId);
    expect(thread?.resolved).toBe(true);
    expect(thread?.comments.map((c) => c.text).slice(2)).toEqual(['Thanks', 'EI60']);
    expect(r.doc.meta.comments[spec.id].map((t) => t.id)).toEqual([newThread]);
    // A thread removed on one side survives a reply on the other.
    const removed = apply(opened, [op('meta.comment.removeThread', { threadId })]).doc;
    const kept = mergeDocuments(opened, removed, theirs).doc;
    expect(Object.values(kept.meta.comments).flat().map((t) => t.id)).toEqual([threadId]);
    expect(Object.values(mergeDocuments(opened, removed, opened).doc.meta.comments).flat()).toEqual([]);
  });
});
