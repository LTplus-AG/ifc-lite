/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publish-as-layer eligibility and provenance for a flow run (#5167 Phase
 * 2 leftover). Publish reuses `publishViewerDraft` (the same path the
 * Layers panel's Draft section uses) — this module only answers two
 * questions: can THIS run be published, and which nodes' tracking keys
 * should the layer's provenance name.
 */

import type { FlowDocument, NodeRegistry, RunResult } from '@ifc-lite/flow';
import type { TranslationKey } from '@/i18n/en';

export interface FlowPublishEligibility {
  readonly canPublish: boolean;
  /** Why publishing is disabled (an i18n key); `undefined` when `canPublish` is true. */
  readonly reason?: TranslationKey;
}

/** Disabled before a successful run, or after a run that wrote nothing. */
export function flowPublishEligibility(
  lastRun: RunResult | null, lastError: string | null, pendingOutsideRun = 0, pendingInRun = 1,
): FlowPublishEligibility {
  if (!lastRun) return { canPublish: false, reason: lastError ? 'flowPanel.publish.reason.failed' : 'flowPanel.publish.reason.noRun' };
  if (!lastRun.ok) return { canPublish: false, reason: 'flowPanel.publish.reason.failed' };
  if (lastRun.writes === 0) return { canPublish: false, reason: 'flowPanel.publish.reason.noWrites' };
  // The run wrote, but none of its edits is still pending: they were already
  // published (the publish clears them) or undone. Publishing again would
  // send an empty layer (#5380 review).
  if (pendingInRun === 0) return { canPublish: false, reason: 'flowPanel.publish.reason.nothingPending' };
  // Publishing moves the run's edits into a layer and then clears the pending
  // set. Removing only the run's edits from a shared overlay is not possible
  // in general — a manual edit can touch the very property the run wrote — so
  // with anything else pending, the honest options are to publish or undo it
  // first. Clearing it would silently lose the user's work (#5380 review).
  if (pendingOutsideRun > 0) return { canPublish: false, reason: 'flowPanel.publish.reason.otherEdits' };
  return { canPublish: true };
}

/**
 * How many pending edits would be lost by clearing after a publish of this
 * run: every edit outside the run's window, on any model, plus any pending
 * georeferencing change (`clearAllMutations` drops those too).
 */
export function countPendingOutsideRun(
  mutations: readonly { id: string }[], window: RunMutations | null, otherPending: number,
): number {
  const inRun = window ? mutationsInRun(mutations, window).length : 0;
  return mutations.length - inRun + otherPending;
}

export interface WritingNode {
  readonly nodeId: string;
  /** The node's declared tracking key, falling back to its label or id when tracking is off. */
  readonly trackingKey: string;
}

/**
 * The write nodes whose last run succeeded — `RunResult` reports status per
 * node but not "did it write", so this cross-references the doc against the
 * registry (`def.writes === 'model'`) the same way the scheduler decides to
 * bump `writesThisRun`.
 */
export function writingNodes(doc: FlowDocument, registry: NodeRegistry<unknown>, lastRun: RunResult): WritingNode[] {
  const reportByNode = new Map(lastRun.reports.map((r) => [r.nodeId, r]));
  const out: WritingNode[] = [];
  for (const node of doc.nodes) {
    const def = registry.get(node.type);
    if (!def?.writes) continue;
    const report = reportByNode.get(node.id);
    if (!report || report.status !== 'ok') continue;
    out.push({ nodeId: node.id, trackingKey: node.trackingKey ?? node.label ?? node.id });
  }
  return out;
}

/** Default publish intent text: names the graph and the nodes that wrote. */
export function flowPublishIntent(doc: FlowDocument, nodes: readonly WritingNode[]): string {
  const keys = nodes.map((n) => n.trackingKey).join(', ');
  return `Published from flow "${doc.name}" — wrote: ${keys}`;
}

/**
 * `author.kind` for a flow-graph publish: `hybrid`, per 03-provenance.md's
 * definition — "a human steering an agent in one draft", the human as
 * `principal` and the graph as `tool`/`session`. `agent` would erase the human
 * who chose to run the graph and to publish its result.
 */
export const FLOW_PUBLISH_AUTHOR_KIND = 'hybrid' as const;

/** The part of a recorded run Publish needs: which pending mutations it created. */
export interface RunMutations {
  readonly mutationIds: ReadonlySet<string>;
}

/**
 * The pending mutations one run produced, by id (recorded when the run
 * finished; see `FlowRunWindow.mutationIds`). An edit made by hand after the
 * run is never among them, even one in the same millisecond.
 */
export function mutationsInRun<T extends { id: string }>(mutations: readonly T[], run: RunMutations): T[] {
  return mutations.filter((mutation) => run.mutationIds.has(mutation.id));
}
