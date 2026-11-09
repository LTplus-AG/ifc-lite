// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Undo anchors are entity IDs, so snapshots may rebuild numeric positions.
 * Reorder in O(current records + restored records), without retaining a prefix. */
export function restoreEntityOrder(keys: Iterable<number>, before: ReadonlyMap<number, number | null>): number[] {
  const links = new Map<number, { previous: number | null; next: number | null }>();
  let head: number | null = null, tail: number | null = null;
  for (const id of keys) {
    links.set(id, { previous: tail, next: null });
    if (tail !== null) links.get(tail)!.next = id;
    else head = id;
    tail = id;
  }
  const pending = new Set(before.keys());
  for (const id of before.keys()) {
    const chain: number[] = [];
    let current: number | null = id;
    while (current !== null && pending.delete(current)) { chain.push(current); current = before.get(current) ?? null; }
    for (const key of chain.reverse()) {
      const next = before.get(key) ?? null, node = links.get(key);
      if (!node || next !== null && !links.has(next)) throw new Error('Created entity order changed before undo');
      if (next === key) continue;
      if (node.previous !== null) links.get(node.previous)!.next = node.next;
      else head = node.next;
      if (node.next !== null) links.get(node.next)!.previous = node.previous;
      else tail = node.previous;
      const previous = next === null ? tail : links.get(next)!.previous;
      node.previous = previous; node.next = next;
      if (previous !== null) links.get(previous)!.next = key;
      else head = key;
      if (next !== null) links.get(next)!.previous = key;
      else tail = key;
    }
  }
  const result: number[] = [];
  while (head !== null && result.length < links.size) { result.push(head); head = links.get(head)!.next; }
  if (result.length !== links.size || head !== null) throw new Error('Created entity order contains a cycle');
  return result;
}
