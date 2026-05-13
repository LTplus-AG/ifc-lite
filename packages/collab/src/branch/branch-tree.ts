/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Branch-tree visualization data (spec §16.2 / §19 v0.7).
 *
 * Pure data helper that turns a `HistorySidecar` into a (nodes, edges)
 * tree the UI layer can render. We deliberately produce nothing
 * pixel-related — apps choose between a force-directed layout, a git
 * log columnar layout, or a simple list. The tree is just the
 * branching structure.
 */

import type { BranchInfo, HistoryEntry, HistorySidecar } from './history.js';

export interface BranchTreeNode {
  /** Entry id (or branch-anchor `'branch:<name>'` for the empty branch root). */
  id: string;
  kind: 'entry' | 'branch-anchor' | 'merge';
  branch: string;
  at: string;
  label?: string;
  /** Parent node id (predecessor on the same branch, or anchor). */
  parentId?: string;
  /** For merge nodes, the second parent (the branch being merged in). */
  mergedFromBranch?: string;
}

export interface BranchTreeEdge {
  from: string;
  to: string;
  kind: 'history' | 'fork' | 'merge';
}

export interface BranchTree {
  nodes: BranchTreeNode[];
  edges: BranchTreeEdge[];
  branches: BranchInfo[];
}

/**
 * Build a branch-tree view from a sidecar. Single pass: collect
 * branches + entries, link entries to their predecessor on the same
 * branch, and emit fork edges from the parent branch's
 * `forkedFromEntryId` to the new branch's first entry (or anchor).
 */
export async function buildBranchTree(sidecar: HistorySidecar): Promise<BranchTree> {
  const branches = await sidecar.branches();
  const all = await sidecar.entries();

  const byBranch = new Map<string, HistoryEntry[]>();
  for (const e of all) {
    const arr = byBranch.get(e.branch) ?? [];
    arr.push(e);
    byBranch.set(e.branch, arr);
  }
  for (const arr of byBranch.values()) arr.sort((a, b) => a.at.localeCompare(b.at));

  const nodes: BranchTreeNode[] = [];
  const edges: BranchTreeEdge[] = [];

  for (const branch of branches) {
    const entries = byBranch.get(branch.name) ?? [];
    const anchorId = `branch:${branch.name}`;
    nodes.push({
      id: anchorId,
      kind: 'branch-anchor',
      branch: branch.name,
      at: branch.createdAt,
    });

    // Fork edge from the parent entry to the anchor.
    if (branch.forkedFromEntryId) {
      edges.push({ from: branch.forkedFromEntryId, to: anchorId, kind: 'fork' });
    }

    let prevId: string = anchorId;
    for (const e of entries) {
      // Trust the structural metadata set by `merge()`, not the label.
      // A user can authorin a regular commit with `label: "merge bar"`
      // and we don't want that to render as a merge node.
      const isMerge = typeof e.mergedFromBranch === 'string';
      const node: BranchTreeNode = {
        id: e.entryId,
        kind: isMerge ? 'merge' : 'entry',
        branch: e.branch,
        at: e.at,
        label: e.label,
        parentId: prevId,
      };
      if (isMerge) {
        node.mergedFromBranch = e.mergedFromBranch;
      }
      nodes.push(node);
      edges.push({ from: prevId, to: e.entryId, kind: 'history' });
      // Use the immutable `mergedFromEntryId` captured at merge time —
      // pointing at the source branch's CURRENT tip would drift the
      // merge edge whenever that branch advances later.
      if (isMerge && e.mergedFromEntryId) {
        edges.push({ from: e.mergedFromEntryId, to: e.entryId, kind: 'merge' });
      }
      prevId = e.entryId;
    }
  }

  return { nodes, edges, branches };
}
