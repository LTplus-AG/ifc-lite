/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Evaluation order of a document's nodes. */

import type { FlowDocument } from './document.js';

export class FlowCycleError extends Error {
  constructor(readonly nodeIds: readonly string[]) {
    super(`flow has a cycle through ${nodeIds.join(' → ')}`);
    this.name = 'FlowCycleError';
  }
}

/** Kahn's algorithm; stable with respect to document node order. */
export function topologicalOrder(doc: FlowDocument): string[] {
  const indegree = new Map<string, number>(doc.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(doc.nodes.map((n) => [n.id, []]));
  for (const e of doc.edges) {
    out.get(e.from[0])!.push(e.to[0]);
    indegree.set(e.to[0], (indegree.get(e.to[0]) ?? 0) + 1);
  }
  const ready = doc.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of out.get(id)!) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) ready.push(next);
    }
  }
  if (order.length !== doc.nodes.length) {
    throw new FlowCycleError(doc.nodes.map((n) => n.id).filter((id) => !order.includes(id)));
  }
  return order;
}
