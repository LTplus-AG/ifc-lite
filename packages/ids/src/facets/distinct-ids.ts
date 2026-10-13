/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ids of several lists, each once, in first-seen order (#7537).
 *
 * An entity facet whose name lists classes keeps one candidate per entity,
 * however many listed values return it, and the exported filters still
 * return every list they returned before #7537. The ids already taken
 * are held in a `Set`, which costs a hash and an entry per distinct id. A
 * `Set` has an engine limit (V8 throws `RangeError: Set maximum size
 * exceeded` on the insert past 2^24 entries), so when an insert is refused
 * the ids go on in a new `Set`, and a lookup checks each one. So the `Set`
 * limit no longer caps the result; array length and memory still do, as
 * they did before.
 *
 * Each list is read once, in full, before the next is taken from `lists`, as
 * the filter's plain loop did before #7537.
 */
export function distinctIds(lists: Iterable<Iterable<number>>): number[] {
  const ids: number[] = [];
  const seen = [new Set<number>()];
  let current = seen[0];
  for (const list of lists) {
    // One push per id: spreading a type's ids as call arguments throws a
    // RangeError once a type has more than about 125,000 instances (#7481).
    for (const id of list) {
      if (current.has(id)) continue;
      if (seen.length > 1 && seen.some((set) => set !== current && set.has(id))) continue;
      try {
        current.add(id);
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        current = new Set([id]);
        seen.push(current);
      }
      ids.push(id);
    }
  }
  return ids;
}
