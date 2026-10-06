/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FlowDocument } from '@ifc-lite/flow';

/**
 * `ids` plus every node that feeds them, directly or through other nodes.
 * Iteration order is `ids` first, then breadth-first: nearest inputs first.
 */
export function withUpstream(doc: Pick<FlowDocument, 'edges'>, ids: Iterable<string>): Set<string> {
  const seen = new Set(ids);
  const pending = [...seen];
  for (let next = 0; next < pending.length; next++) {
    const id = pending[next];
    for (const edge of doc.edges) if (edge.to[0] === id && !seen.has(edge.from[0])) {
      seen.add(edge.from[0]); pending.push(edge.from[0]);
    }
  }
  return seen;
}
