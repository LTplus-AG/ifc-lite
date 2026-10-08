/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A bSDD dictionary as a class tree, and the class hierarchy resolved for
 * property inheritance (05-bsdd.md §2.3, IDS-072). Parent links come from
 * the server, so every walk here is iterative with a visited set and a
 * work budget: a cyclic or absurdly deep hierarchy ends, it does not hang.
 */

import type { BsddClass, BsddClassProperty, BsddClassSummary, BsddSource } from './types.js';

export interface BsddClassTreeNode {
  uri: string;
  code: string;
  name: string;
  depth: number;
  children: BsddClassTreeNode[];
}

/**
 * The parent/child tree of a dictionary's flat class list. A class whose
 * parent is missing (or that sits on a parent cycle) becomes a root.
 */
export function buildClassTree(rows: readonly BsddClassSummary[]): BsddClassTreeNode[] {
  const byCode = new Map<string, BsddClassSummary>();
  for (const r of rows) if (!byCode.has(r.code)) byCode.set(r.code, r);
  const childrenOf = new Map<string, BsddClassSummary[]>();
  const roots: BsddClassSummary[] = [];
  for (const r of byCode.values()) {
    const parent = r.parentClassCode;
    if (parent && parent !== r.code && byCode.has(parent) && !onCycle(r.code, byCode)) {
      const list = childrenOf.get(parent) ?? [];
      list.push(r);
      childrenOf.set(parent, list);
    } else {
      roots.push(r);
    }
  }
  const out: BsddClassTreeNode[] = [];
  const stack: { row: BsddClassSummary; depth: number; into: BsddClassTreeNode[] }[] = roots.map((row) => ({ row, depth: 0, into: out }));
  stack.reverse();
  const placed = new Set<string>();
  while (stack.length) {
    const { row, depth, into } = stack.pop() as (typeof stack)[number];
    if (placed.has(row.code)) continue;
    placed.add(row.code);
    const node: BsddClassTreeNode = { uri: row.uri, code: row.code, name: row.name, depth, children: [] };
    into.push(node);
    const kids = childrenOf.get(row.code) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ row: kids[i], depth: depth + 1, into: node.children });
  }
  return out;
}

/** Whether following parent codes from `code` comes back to it. */
function onCycle(code: string, byCode: ReadonlyMap<string, BsddClassSummary>): boolean {
  const seen = new Set<string>([code]);
  let cursor = byCode.get(code)?.parentClassCode;
  while (cursor && byCode.has(cursor)) {
    if (seen.has(cursor)) return cursor === code;
    seen.add(cursor);
    cursor = byCode.get(cursor)?.parentClassCode;
  }
  return false;
}

/** Default bound on classes fetched for one generator run. */
export const MAX_CLASSES = 2000;

/**
 * Fetch the selected classes and every ancestor (for inherited
 * properties). Classes bSDD does not know are reported, not thrown.
 */
export async function loadClassesWithAncestors(
  source: BsddSource,
  uris: readonly string[],
  options: { maxClasses?: number; languageCode?: string } = {},
): Promise<{ classes: Map<string, BsddClass>; missing: string[]; truncated: boolean }> {
  const max = options.maxClasses ?? MAX_CLASSES;
  const classes = new Map<string, BsddClass>();
  const missing: string[] = [];
  const queue = [...new Set(uris)];
  const queued = new Set(queue);
  let truncated = false;
  while (queue.length) {
    if (classes.size + missing.length >= max) {
      truncated = true;
      break;
    }
    const uri = queue.shift() as string;
    const cls = await source.getClass(uri, options.languageCode ? { languageCode: options.languageCode } : {});
    if (!cls) {
      missing.push(uri);
      continue;
    }
    classes.set(uri, cls);
    const parent = cls.parentClass?.uri;
    if (parent && !queued.has(parent)) {
      queued.add(parent);
      queue.push(parent);
    }
  }
  return { classes, missing, truncated };
}

/** The class's ancestors, nearest first (cycle-safe). */
export function ancestors(cls: BsddClass, classes: ReadonlyMap<string, BsddClass>): BsddClass[] {
  const out: BsddClass[] = [];
  const seen = new Set<string>([cls.uri]);
  let cursor = cls.parentClass ? classes.get(cls.parentClass.uri) : undefined;
  while (cursor && !seen.has(cursor.uri)) {
    out.push(cursor);
    seen.add(cursor.uri);
    cursor = cursor.parentClass ? classes.get(cursor.parentClass.uri) : undefined;
  }
  return out;
}

/**
 * Own plus inherited properties. A property the class redefines (same set
 * and code) overrides the ancestor's definition; inherited properties come
 * first, in root-to-leaf order, so a family of classes lists them alike.
 */
export function effectiveProperties(cls: BsddClass, classes: ReadonlyMap<string, BsddClass>): BsddClassProperty[] {
  const chain = [...ancestors(cls, classes)].reverse();
  chain.push(cls);
  const byKey = new Map<string, BsddClassProperty>();
  for (const c of chain) {
    for (const p of c.properties) byKey.set(`${p.propertySet ?? ''}\u0000${p.code}`, p);
  }
  return [...byKey.values()];
}
