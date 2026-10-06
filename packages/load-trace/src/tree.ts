/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LoadTraceSnapshot, TraceSpan } from './types.js';

export interface SpanTreeNode {
  span: TraceSpan;
  children: SpanTreeNode[];
}

/**
 * Nest a snapshot's flat span list by `parentId`. Returns the root's direct
 * children, each list ordered by start time (ties keep recording order).
 */
export function buildSpanTree(snapshot: LoadTraceSnapshot): SpanTreeNode[] {
  const nodes = new Map<number, SpanTreeNode>();
  for (const span of snapshot.spans) nodes.set(span.id, { span, children: [] });
  const roots: SpanTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentId === null ? undefined : nodes.get(node.span.parentId);
    (parent ? parent.children : roots).push(node);
  }
  const order = (list: SpanTreeNode[]): void => {
    list.sort((a, b) => a.span.start - b.span.start || a.span.id - b.span.id);
    for (const n of list) order(n.children);
  };
  order(roots);
  return roots;
}
