/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Put the median at `target`, with every smaller item before it. Checkpoints
 * let the browser builder yield without keeping a second selection algorithm.
 * A work cap turns adversarial quickselect inputs into bounded heapsort work.
 */
export function* selectMedian(
  indices: number[], start: number, end: number, target: number,
  compare: (a: number, b: number) => number,
  maxPartitionWork = 8 * (end - start),
): Generator<void> {
  let work = 0;
  let checkpoint = 0;
  while (end - start > 1) {
    if (work >= maxPartitionWork) {
      yield* heapSort(indices, start, end, compare);
      return;
    }
    const mid = start + Math.floor((end - start) / 2);
    const first = indices[start], middle = indices[mid], last = indices[end - 1];
    const pivot = compare(first, middle) < 0
      ? (compare(middle, last) < 0 ? middle : compare(first, last) < 0 ? last : first)
      : (compare(first, last) < 0 ? first : compare(middle, last) < 0 ? last : middle);
    let lower = start, cursor = start, upper = end - 1;
    while (cursor <= upper) {
      const order = compare(indices[cursor], pivot);
      work++;
      if (order < 0) {
        [indices[lower], indices[cursor]] = [indices[cursor], indices[lower]];
        lower++; cursor++;
      } else if (order > 0) {
        [indices[cursor], indices[upper]] = [indices[upper], indices[cursor]];
        upper--;
      } else cursor++;
      if (++checkpoint === 1024) {
        checkpoint = 0;
        yield;
      }
    }
    if (target < lower) end = lower;
    else if (target > upper) start = upper + 1;
    else return;
  }
}

/** In-place O(n log n) fallback; every long sift has a scheduling checkpoint. */
function* heapSort(
  indices: number[], start: number, end: number,
  compare: (a: number, b: number) => number,
): Generator<void> {
  const length = end - start;
  let checkpoint = 0;
  function* siftDown(root: number, heapLength: number): Generator<void> {
    while (2 * root + 1 < heapLength) {
      const left = 2 * root + 1;
      let larger = left;
      if (left + 1 < heapLength && compare(indices[start + left], indices[start + left + 1]) < 0) {
        larger = left + 1;
      }
      if (compare(indices[start + root], indices[start + larger]) >= 0) return;
      [indices[start + root], indices[start + larger]] = [indices[start + larger], indices[start + root]];
      root = larger;
      if (++checkpoint === 1024) {
        checkpoint = 0;
        yield;
      }
    }
  }
  for (let root = Math.floor(length / 2) - 1; root >= 0; root--) {
    yield* siftDown(root, length);
    if (++checkpoint === 1024) { checkpoint = 0; yield; }
  }
  for (let tail = length - 1; tail > 0; tail--) {
    [indices[start], indices[start + tail]] = [indices[start + tail], indices[start]];
    yield* siftDown(0, tail);
    if (++checkpoint === 1024) { checkpoint = 0; yield; }
  }
}
