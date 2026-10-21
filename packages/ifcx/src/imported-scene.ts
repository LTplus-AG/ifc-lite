/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ComposedNode } from './types.js';
import { executeImportedGraph } from './imported-graph.js';

/** Both parser entries consume the same Rust mesh-then-point program. */
export function extractImportedScene(composed: Map<string, ComposedNode>, pathToId: Map<string, number>) {
  return executeImportedGraph(composed, pathToId, 3);
}
