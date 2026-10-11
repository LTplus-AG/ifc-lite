/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Comment threads in a three-way merge. Discussion is additive, so it
 * merges without conflicts: new threads from both sides are kept, replies
 * from both sides are appended (ours first), and the resolved flag follows
 * the side that changed it (theirs when both did). A thread removed on one
 * side survives when the other side replied to it. Replies removed on one
 * side stay removed unless the other side replied.
 */

import type { CommentThread, StudioDocument } from '../document/types.js';
import type { PrimitiveOp } from '../ops/types.js';
import { applyPrimitive } from '../reducer/apply.js';
import { findThread } from '../reducer/comment-ops.js';
import { deriveId, type Uuid } from '../uuid.js';

interface Site {
  nodeId: Uuid;
  thread: CommentThread;
}

function threads(doc: StudioDocument): Map<Uuid, Site> {
  const out = new Map<Uuid, Site>();
  for (const [nodeId, list] of Object.entries(doc.meta.comments)) for (const thread of list) out.set(thread.id, { nodeId, thread });
  return out;
}

const key = (c: CommentThread['comments'][number]) => `${c.author}\u0000${c.at}\u0000${c.text}`;

/** Ops that add both sides' comment changes to `merged` (which carries the base threads). */
export function commentMergeOps(base: StudioDocument, ours: StudioDocument, theirs: StudioDocument, merged: StudioDocument, seed: string): PrimitiveOp[] {
  const ops: PrimitiveOp[] = [];
  let doc = merged;
  const push = <K extends PrimitiveOp['kind']>(kind: K, payload: Extract<PrimitiveOp, { kind: K }>['payload']) => {
    const op = { kind, opId: deriveId(seed, `comments:${ops.length}`), payload } as PrimitiveOp;
    doc = applyPrimitive(doc, op).doc;
    ops.push(op);
  };
  const b = threads(base);
  const o = threads(ours);
  const t = threads(theirs);
  for (const id of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
    const bs = b.get(id);
    const os = o.get(id);
    const ts = t.get(id);
    if (!bs) {
      // New on one side (thread ids are fresh UUIDs, so never on both).
      const site = os ?? ts;
      if (site && !findThread(doc, id)) push('meta.comment.restoreThread', { nodeId: site.nodeId, index: (doc.meta.comments[site.nodeId] ?? []).length, thread: site.thread });
      continue;
    }
    const n = bs.thread.comments.length;
    const extra = (s: Site | undefined) => (s ? s.thread.comments.slice(n) : []);
    const added = [...extra(os)];
    for (const c of extra(ts)) if (!added.some((x) => key(x) === key(c))) added.push(c);
    if ((!os || !ts) && !added.length) {
      push('meta.comment.removeThread', { threadId: id });
      continue;
    }
    if (!added.length) {
      const keep = Math.min(os?.thread.comments.length ?? n, ts?.thread.comments.length ?? n);
      for (let k = n; k > Math.max(keep, 1); k--) push('meta.comment.removeReply', { threadId: id });
    }
    for (const c of added) push('meta.comment.reply', { threadId: id, ...c });
    const resolved = ts && ts.thread.resolved !== bs.thread.resolved ? ts.thread.resolved : os && os.thread.resolved !== bs.thread.resolved ? os.thread.resolved : bs.thread.resolved;
    if (resolved !== bs.thread.resolved) push('meta.comment.resolve', { threadId: id, resolved });
  }
  return ops;
}
