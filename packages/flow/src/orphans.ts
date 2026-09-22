/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FlowDocument, FlowNode } from './document.js';
import type { LogLevel, NodeRegistry } from './registry.js';
import type { TrackedEntry, TrackedSet, TrackingStore } from './tracking.js';
import type { RunLogEntry } from './scheduler.js';

/** Log entries of the orphan sweep carry this in place of a node id. */
export const ORPHAN_NODE_ID = '(deleted node)';

export function trackingKeyOf(doc: FlowDocument, node: FlowNode): string {
  return node.trackingKey ?? `${doc.name}/${node.label ?? node.id}`;
}

/**
 * Remove every element of a set through its recorded node type's `remove`.
 * Entries that were removed are dropped from the set; a set with failures
 * keeps only the failed entries, so the next run retries those and not the
 * ones already gone. Returns the set left over (undefined when empty).
 */
export async function removeSet<H>(
  set: TrackedSet,
  registry: NodeRegistry<unknown>,
  host: H,
  signal: AbortSignal | undefined,
  log: RunLogEntry[],
  nodeId: string,
): Promise<{ removed: number; errors: number; rest: TrackedSet | undefined }> {
  const say = (level: LogLevel, laneKey: string | null, message: string) => log.push({ nodeId, laneKey, level, message });
  const def = set.nodeType ? registry.get(set.nodeType) : undefined;
  if (!def?.remove) {
    say('warn', null, `tracked set "${set.trackingKey}" has ${set.nodeType ? `type "${set.nodeType}", which cannot remove elements` : 'no recorded type'}; its ${Object.keys(set.entries).length} element(s) stay in the model`);
    return { removed: 0, errors: 0, rest: set };
  }
  let removed = 0;
  const failed: Record<string, TrackedEntry> = {};
  for (const [laneKey, entry] of Object.entries(set.entries)) {
    try {
      await def.remove({ host, laneKey, tracking: undefined, signal, log: (level, message) => say(level, laneKey, message) }, entry.globalId);
      removed += 1;
    } catch (err) {
      failed[laneKey] = entry;
      say('error', laneKey, `remove ${entry.globalId} of "${set.trackingKey}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const errors = Object.keys(failed).length;
  return { removed, errors, rest: errors > 0 ? { ...set, entries: failed } : undefined };
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
    const r = await removeSet(set, registry, host, signal, log, ORPHAN_NODE_ID);
    removed += r.removed;
    errors += r.errors;
    if (r.rest === undefined) {
      store.delete(key);
      log.push({ nodeId: ORPHAN_NODE_ID, laneKey: null, level: 'info', message: `removed ${r.removed} element(s) of deleted node "${key}"` });
    } else if (r.rest !== set) {
      // Keep only what still needs removing, so a retry does not re-run the
      // removals that already succeeded.
      store.save(r.rest);
    }
  }
  return { removed, errors };
}
