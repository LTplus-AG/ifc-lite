/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Three-way merge at the op level (02-document-model-and-ops.md §6).
 *
 * `base`, `ours` and `theirs` are revisions of one Studio document. Each
 * side's change set is its semantic diff from `base`; every diff entry is
 * one change unit with a key (`scopeOf`). Changes on keys only one side
 * touched merge automatically, identical changes merge once, and the rest
 * become conflicts:
 *
 * - `field`: both sides changed one key differently;
 * - `deleteEdit`: one side removed a node (or replaced a facet) that the
 *   other side changed.
 *
 * A conflict is resolved by choosing a side (`options.resolutions`); an
 * unresolved one keeps the base. Order is settled per list (`order.ts`).
 * The merged change set is turned into primitive ops with `diffToOps`, so
 * the result is reachable through ops, and those ops can be re-checked by
 * the grounding gate (`options.gate`). Comment threads merge additively
 * (`comments.ts`).
 */

import { diffDocuments } from '../diff/diff.js';
import { diffToOps } from '../diff/patch.js';
import type { DiffEntry, DocumentDiff } from '../diff/types.js';
import type { StudioDocument } from '../document/types.js';
import { checkOps } from '../gate/check.js';
import { canonical } from '../match/cascade.js';
import type { StudioOp } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { commentMergeOps } from './comments.js';
import { contentKeyOf, isOrderKey, scopeOf } from './keys.js';
import { mergeOrder } from './order.js';
import type { MergeConflict, MergeDiagnostic, MergeOptions, MergeResult, MergeSide } from './types.js';

type Grouped = Map<string, DiffEntry[]>;

function group(entries: readonly DiffEntry[]): Grouped {
  const out: Grouped = new Map();
  for (const e of entries) {
    const { key } = scopeOf(e);
    const list = out.get(key) ?? [];
    list.push(e);
    out.set(key, list);
  }
  return out;
}

/** What a change sets, without rendering context (names, indices, sibling fields). */
function payload(e: DiffEntry): unknown {
  switch (e.kind) {
    case 'info.changed':
    case 'spec.changed':
    case 'requirement.changed':
      return [e.kind, e.field, e.new];
    case 'facet.valueChanged':
      return [e.kind, e.field, e.new];
    case 'facet.relationChanged':
      return [e.kind, e.new];
    case 'facet.moved':
      return [e.kind, e.to.specId, e.to.section];
    case 'spec.moved':
      return [e.kind];
    case 'facet.added':
      return [e.kind, e.facet, e.requirement, e.specId, e.section];
    case 'facet.replaced':
      return [e.kind, e.facet, e.requirement];
    case 'spec.added':
      return [e.kind, e.spec];
    default:
      return [e.kind, 'decl' in e ? e.decl : e.specId];
  }
}

function sameChange(a: readonly DiffEntry[] | undefined, b: readonly DiffEntry[] | undefined): boolean {
  return canonical((a ?? []).map(payload)) === canonical((b ?? []).map(payload));
}

/** Union-find over conflict keys, so overlapping conflicts become one. */
class Groups {
  private parent = new Map<string, string>();
  find(k: string): string {
    let r = k;
    while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r) as string;
    return r;
  }
  union(a: string, b: string): void {
    if (!this.parent.has(a)) this.parent.set(a, a);
    if (!this.parent.has(b)) this.parent.set(b, b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
  has(k: string): boolean {
    return this.parent.has(k);
  }
}

function conflicting(ours: Grouped, theirs: Grouped): Groups {
  const groups = new Groups();
  for (const [key, list] of ours) {
    if (isOrderKey(key) || !theirs.has(key)) continue;
    if (!sameChange(list, theirs.get(key))) groups.union(key, key);
  }
  // Node-wide changes (removal, facet replacement) against any other change of that node.
  const nodeWide = (side: Grouped, other: Grouped) => {
    for (const [key, list] of side) {
      for (const e of list) {
        const scope = scopeOf(e);
        const node = scope.deletes ?? (e.kind === 'facet.replaced' ? e.facetId : undefined);
        if (!node) continue;
        for (const [otherKey, otherList] of other) {
          if (isOrderKey(otherKey) || (otherKey === key && sameChange(list, otherList))) continue;
          const touches = otherList.some((x) => scopeOf(x).nodes.includes(node));
          const sameFacet = e.kind === 'facet.replaced' && contentKeyOf(otherKey) === key;
          if (touches || sameFacet) groups.union(key, otherKey);
        }
      }
    }
  };
  nodeWide(ours, theirs);
  nodeWide(theirs, ours);
  return groups;
}

function conflictOf(id: string, keys: string[], ours: Grouped, theirs: Grouped, resolution: MergeSide | undefined): MergeConflict {
  const o = keys.flatMap((k) => ours.get(k) ?? []);
  const t = keys.flatMap((k) => theirs.get(k) ?? []);
  const all = [...o, ...t];
  const deleting = all.find((e) => scopeOf(e).deletes || e.kind === 'facet.replaced');
  const facet = all.find((e): e is Extract<DiffEntry, { facetId: string }> => 'facetId' in e);
  const spec = all.find((e): e is Extract<DiffEntry, { specId: string }> => 'specId' in e);
  return {
    id,
    kind: deleting ? 'deleteEdit' : 'field',
    ...(spec ? { specId: spec.specId } : {}),
    ...(facet ? { facetId: facet.facetId } : {}),
    ours: o,
    theirs: t,
    ...(resolution ? { resolution } : {}),
  };
}

/** Merge `ours` and `theirs`, two revisions derived from `base`. */
export function mergeDocuments(base: StudioDocument, ours: StudioDocument, theirs: StudioDocument, options: MergeOptions = {}): MergeResult {
  const dOurs = diffDocuments(base, ours, { byNodeId: true });
  const dTheirs = diffDocuments(base, theirs, { byNodeId: true });
  const gOurs = group(dOurs.entries);
  const gTheirs = group(dTheirs.entries);
  const groups = conflicting(gOurs, gTheirs);
  const members = new Map<string, string[]>();
  for (const key of new Set([...gOurs.keys(), ...gTheirs.keys()])) {
    if (!groups.has(key)) continue;
    const root = groups.find(key);
    members.set(root, [...(members.get(root) ?? []), key]);
  }
  const conflicts: MergeConflict[] = [];
  const decided = new Map<string, MergeSide | undefined>();
  for (const keys of members.values()) {
    keys.sort();
    const id = keys.length === 1 ? keys[0] : `node:${keys[0]}`;
    const resolution = options.resolutions?.[id];
    conflicts.push(conflictOf(id, keys, gOurs, gTheirs, resolution));
    for (const k of keys) decided.set(k, resolution);
  }
  const chosen: DiffEntry[] = [];
  for (const key of new Set([...gOurs.keys(), ...gTheirs.keys()])) {
    if (decided.has(key)) {
      const side = decided.get(key);
      if (side) chosen.push(...((side === 'ours' ? gOurs : gTheirs).get(key) ?? []));
      continue;
    }
    chosen.push(...(gOurs.get(key) ?? gTheirs.get(key) ?? []));
  }
  const diagnostics: MergeDiagnostic[] = [];
  const merged: DocumentDiff = {
    identical: chosen.length === 0,
    byNodeId: true,
    entries: chosen,
    specs: [],
    order: mergeOrder(base, dOurs, dTheirs, chosen, diagnostics),
  };
  const seed = options.seed ?? `merge:${base.docId}`;
  const contentOps = diffToOps(base, merged, { seed });
  if (options.gate) {
    const gate = checkOps(contentOps, base, options.gate);
    for (const issue of gate.issues) diagnostics.push({ code: 'MERGE-GATE-001', message: issue.message, issue });
  }
  const content = apply(base, contentOps).doc;
  const commentOps = commentMergeOps(base, ours, theirs, content, seed);
  const ops = [...contentOps, ...commentOps];
  const doc = apply(content, commentOps).doc;
  const unresolved = conflicts.some((c) => !c.resolution);
  return { doc, ops, conflicts, diagnostics, clean: !unresolved && !diagnostics.some((d) => d.code === 'MERGE-GATE-001') };
}

/** Merge two op sequences applied to `base` (e.g. two offline edit sessions). */
export function mergeOps(base: StudioDocument, ours: readonly StudioOp[], theirs: readonly StudioOp[], options: MergeOptions = {}): MergeResult {
  return mergeDocuments(base, apply(base, ours).doc, apply(base, theirs).doc, options);
}
