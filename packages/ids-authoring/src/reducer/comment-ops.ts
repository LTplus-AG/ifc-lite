/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reducers for `meta.comment.*` (sidecar only; IDS content is untouched).
 * Threads live in `meta.comments[nodeId]` and are addressed by thread id.
 * A thread can only be opened on a live node, but it outlives its node:
 * removing a specification leaves its threads in place, so the discussion
 * survives undo and re-identification.
 */

import { locateNode } from '../document/node-index.js';
import type { CommentThread, StudioDocument } from '../document/types.js';
import type {
  MetaCommentAddOp,
  MetaCommentRemoveReplyOp,
  MetaCommentRemoveThreadOp,
  MetaCommentReplyOp,
  MetaCommentResolveOp,
  MetaCommentRestoreThreadOp,
} from '../ops/types.js';
import type { Uuid } from '../uuid.js';
import { insertAt, OpApplyError, removeAt, replaceAt } from './edit.js';
import { inv, type StepResult } from './spec-ops.js';

interface ThreadSite {
  nodeId: Uuid;
  index: number;
  thread: CommentThread;
}

export function findThread(doc: StudioDocument, threadId: Uuid): ThreadSite | undefined {
  for (const [nodeId, threads] of Object.entries(doc.meta.comments)) {
    const index = threads.findIndex((t) => t.id === threadId);
    if (index >= 0) return { nodeId, index, thread: threads[index] };
  }
  return undefined;
}

function requireThread(doc: StudioDocument, threadId: Uuid): ThreadSite {
  const site = findThread(doc, threadId);
  if (!site) throw new OpApplyError('GATE-STR-001', `unknown comment thread ${threadId}`);
  return site;
}

function withThreads(doc: StudioDocument, nodeId: Uuid, threads: CommentThread[]): StudioDocument {
  const comments = { ...doc.meta.comments };
  if (threads.length) comments[nodeId] = threads;
  else delete comments[nodeId];
  return { ...doc, meta: { ...doc.meta, comments } };
}

function setThread(doc: StudioDocument, site: ThreadSite, thread: CommentThread): StudioDocument {
  return withThreads(doc, site.nodeId, replaceAt(doc.meta.comments[site.nodeId], site.index, thread));
}

export function applyCommentAdd(doc: StudioDocument, op: MetaCommentAddOp): StepResult {
  const { nodeId, threadId, author, at, text } = op.payload;
  if (!locateNode(doc, nodeId)) throw new OpApplyError('GATE-STR-001', `unknown node ${nodeId}`);
  if (findThread(doc, threadId)) throw new OpApplyError('GATE-STR-001', `comment thread ${threadId} already exists`);
  const threads = doc.meta.comments[nodeId] ?? [];
  const thread: CommentThread = { id: threadId, resolved: false, comments: [{ author, at, text }] };
  return {
    doc: withThreads(doc, nodeId, [...threads, thread]),
    inverse: [inv(op, 0, 'meta.comment.removeThread', { threadId })],
    touched: [nodeId],
  };
}

export function applyCommentReply(doc: StudioDocument, op: MetaCommentReplyOp): StepResult {
  const { threadId, author, at, text } = op.payload;
  const site = requireThread(doc, threadId);
  return {
    doc: setThread(doc, site, { ...site.thread, comments: [...site.thread.comments, { author, at, text }] }),
    inverse: [inv(op, 0, 'meta.comment.removeReply', { threadId })],
    touched: [site.nodeId],
  };
}

export function applyCommentRemoveReply(doc: StudioDocument, op: MetaCommentRemoveReplyOp): StepResult {
  const site = requireThread(doc, op.payload.threadId);
  const { comments } = site.thread;
  if (comments.length < 2) throw new OpApplyError('GATE-STR-006', 'the opening comment is removed with its thread (meta.comment.removeThread)');
  const last = comments[comments.length - 1];
  return {
    doc: setThread(doc, site, { ...site.thread, comments: comments.slice(0, -1) }),
    inverse: [inv(op, 0, 'meta.comment.reply', { threadId: op.payload.threadId, ...last })],
    touched: [site.nodeId],
  };
}

export function applyCommentResolve(doc: StudioDocument, op: MetaCommentResolveOp): StepResult {
  const site = requireThread(doc, op.payload.threadId);
  return {
    doc: setThread(doc, site, { ...site.thread, resolved: op.payload.resolved }),
    inverse: [inv(op, 0, 'meta.comment.resolve', { threadId: op.payload.threadId, resolved: site.thread.resolved })],
    touched: [site.nodeId],
  };
}

export function applyCommentRemoveThread(doc: StudioDocument, op: MetaCommentRemoveThreadOp): StepResult {
  const site = requireThread(doc, op.payload.threadId);
  return {
    doc: withThreads(doc, site.nodeId, removeAt(doc.meta.comments[site.nodeId], site.index)),
    inverse: [inv(op, 0, 'meta.comment.restoreThread', { nodeId: site.nodeId, index: site.index, thread: site.thread })],
    touched: [site.nodeId],
  };
}

export function applyCommentRestoreThread(doc: StudioDocument, op: MetaCommentRestoreThreadOp): StepResult {
  const { nodeId, index, thread } = op.payload;
  if (findThread(doc, thread.id)) throw new OpApplyError('GATE-STR-001', `comment thread ${thread.id} already exists`);
  const threads = doc.meta.comments[nodeId] ?? [];
  if (!Number.isInteger(index) || index < 0 || index > threads.length) {
    throw new OpApplyError('GATE-STR-006', `thread index ${index} is out of range 0..${threads.length}`);
  }
  return {
    doc: withThreads(doc, nodeId, insertAt(threads, index, thread)),
    inverse: [inv(op, 0, 'meta.comment.removeThread', { threadId: thread.id })],
    touched: [nodeId],
  };
}
