/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FlowDocument, FlowNode } from './document.js';
import type { LogLevel, NodeRegistry } from './registry.js';
import type { TrackingStore } from './tracking.js';
import type { RunLogEntry } from './scheduler.js';

/** Log entries of the orphan sweep carry this in place of a node id. */
export const ORPHAN_NODE_ID = '(deleted node)';

export function trackingKeyOf(doc: FlowDocument, node: FlowNode): string {
  return node.trackingKey ?? `${doc.name}/${node.label ?? node.id}`;
}

/**
 * Sets no tracked node claims any more — the node was deleted, or its
 * tracking key renamed — are removed from the model through the recorded
 * node type's `remove`, then dropped from the store. Deleting a node in the
 * editor and re-running otherwise left its elements in the model with a
 * sidecar entry nothing would ever reconcile: exactly the orphan tracking
 * exists to prevent. A set whose type is unknown here stays, with a warning,
 * rather than being forgotten while its elements remain.
 */
export async function removeOrphanedSets<H>(
  doc: FlowDocument,
  host: H,
  store: TrackingStore | undefined,
  registry: NodeRegistry<unknown>,
  log: RunLogEntry[],
  signal?: AbortSignal,
): Promise<{ removed: number; errors: number }> {
  if (!store) return { removed: 0, errors: 0 };
  const live = new Set(doc.nodes.filter((n) => registry.get(n.type)?.tracked).map((n) => trackingKeyOf(doc, n)));
  let errors = 0;
  let removed = 0;
  for (const key of store.keys()) {
    if (live.has(key)) continue;
    const set = store.load(key);
    if (!set) continue;
    const def = set.nodeType ? registry.get(set.nodeType) : undefined;
    const say = (level: LogLevel, laneKey: string | null, message: string) => log.push({ nodeId: ORPHAN_NODE_ID, laneKey, level, message });
    if (!def?.remove) {
      say('warn', null, `tracked set "${key}" belongs to no node in the graph and its type ${set.nodeType ? `"${set.nodeType}" cannot remove elements` : 'is not recorded'}; its ${Object.keys(set.entries).length} element(s) stay in the model`);
      continue;
    }
    let failedHere = 0;
    for (const [laneKey, entry] of Object.entries(set.entries)) {
      try {
        await def.remove({ host, laneKey, tracking: undefined, signal, log: (level, message) => say(level, laneKey, message) }, entry.globalId);
        removed += 1;
      } catch (err) {
        failedHere += 1;
        say('error', laneKey, `remove ${entry.globalId} of deleted node "${key}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    errors += failedHere;
    // A set with a failed removal stays so the next run retries it.
    if (failedHere === 0) {
      store.delete(key);
      say('info', null, `removed ${Object.keys(set.entries).length} element(s) of deleted node "${key}"`);
    }
  }
  return { removed, errors };
}
