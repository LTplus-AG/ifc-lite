/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Framework-free view model of the comment threads in the sidecar
 * (FR-G07): where each thread is anchored, whether its node still exists,
 * who takes part and whom it mentions. Mentions are names (`@Ana`,
 * `@"Ana Lima"`); e-mail addresses are never treated as mentions.
 */

import { facetLabel } from '../diff/changelog.js';
import { facetAt, locateNode } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import type { Uuid } from '../uuid.js';

export interface CommentAnchor {
  kind: 'document' | 'spec' | 'applicabilityFacet' | 'requirement' | 'constraint' | 'missing';
  specName?: string;
  /** Short facet handle ("FireRating (Pset_DoorCommon)"). */
  facet?: string;
  field?: string;
}

export interface CommentView {
  author: string;
  at: string;
  text: string;
  mentions: string[];
}

export interface CommentThreadView {
  threadId: Uuid;
  nodeId: Uuid;
  anchor: CommentAnchor;
  /** The node no longer exists (thread kept for the record). */
  orphan: boolean;
  resolved: boolean;
  comments: CommentView[];
  participants: string[];
}

export interface CommentsView {
  threads: CommentThreadView[];
  unresolved: number;
  /** Unresolved thread count per node id (for badges in an outline). */
  badges: Record<Uuid, number>;
}

const MENTION = /(?:^|[\s(,;])@(?:"([^"]+)"|([\p{L}\p{N}][\p{L}\p{N}._-]*))/gu;

/** Names mentioned in `text`, in order, without duplicates. */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const name = (m[1] ?? m[2] ?? '').replace(/[._-]+$/, '');
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function anchorOf(doc: StudioDocument, nodeId: Uuid): CommentAnchor {
  const loc = locateNode(doc, nodeId);
  if (!loc) return { kind: 'missing' };
  if (loc.kind === 'document') return { kind: 'document' };
  const specName = doc.ids.specifications[loc.specIndex].name;
  if (loc.kind === 'spec') return { kind: 'spec', specName };
  const facet = facetLabel(facetAt(doc, loc));
  if (loc.kind === 'constraint') return { kind: 'constraint', specName, facet, field: loc.field };
  return { kind: loc.kind, specName, facet };
}

export function commentThreads(doc: StudioDocument, options: { includeResolved?: boolean } = {}): CommentsView {
  const threads: CommentThreadView[] = [];
  const badges: Record<Uuid, number> = {};
  for (const [nodeId, list] of Object.entries(doc.meta.comments)) {
    const anchor = anchorOf(doc, nodeId);
    for (const thread of list) {
      if (!thread.resolved) badges[nodeId] = (badges[nodeId] ?? 0) + 1;
      if (thread.resolved && !options.includeResolved) continue;
      threads.push({
        threadId: thread.id,
        nodeId,
        anchor,
        orphan: anchor.kind === 'missing',
        resolved: thread.resolved,
        comments: thread.comments.map((c) => ({ ...c, mentions: extractMentions(c.text) })),
        participants: [...new Set(thread.comments.map((c) => c.author))],
      });
    }
  }
  threads.sort((a, b) => (a.comments[0]?.at ?? '').localeCompare(b.comments[0]?.at ?? ''));
  return { threads, unresolved: Object.values(badges).reduce((n, k) => n + k, 0), badges };
}
