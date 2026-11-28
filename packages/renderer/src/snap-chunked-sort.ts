/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A stable merge sort over an index array that can be paused between `step`
 * calls (#11504). `Array.prototype.sort` on the vertex or segment list of one
 * very large piece is a single uninterruptible call of tens of milliseconds;
 * here one `step` sorts one block or merges up to one block of output, so an
 * idle slice can stop in the middle and the next slice continues.
 *
 * Same result as `Array.prototype.sort` with the same comparator: both are
 * stable, and the merge takes the left element on ties.
 */

/** Elements one `step` sorts or merges. */
export const SORT_CHUNK = 2048;

export class ChunkedSort {
  private src: Int32Array;
  private dst: Int32Array;
  private readonly n: number;
  private phase: 'runs' | 'merge' | 'done' = 'runs';
  /** `runs`: start of the next block to sort. */
  private pos = 0;
  /** `merge`: width of the sorted runs being merged, and the pair in flight. */
  private width: number;
  private lo = 0; private mid = 0; private hi = 0;
  private i = 0; private j = 0; private k = 0;
  private merging = false;

  /** Sorts `indices` in place (the final order may live in a second buffer: read it with `result`). */
  constructor(indices: Int32Array, private readonly cmp: (a: number, b: number) => number, private readonly chunk = SORT_CHUNK) {
    this.src = indices;
    this.dst = new Int32Array(indices.length);
    this.n = indices.length;
    this.width = chunk;
    if (this.n <= 1) this.phase = 'done';
  }

  get done(): boolean { return this.phase === 'done'; }

  /** Do one bounded piece of work; true once sorted. */
  step(): boolean {
    const { src, dst, n, chunk } = this;
    if (this.phase === 'runs') {
      const end = Math.min(n, this.pos + chunk);
      src.subarray(this.pos, end).sort(this.cmp);
      this.pos = end;
      if (end >= n) this.phase = n <= chunk ? 'done' : 'merge';
      return this.done;
    }
    if (this.phase === 'merge') {
      if (!this.merging) {
        this.mid = Math.min(this.lo + this.width, n);
        this.hi = Math.min(this.lo + 2 * this.width, n);
        this.i = this.lo; this.j = this.mid; this.k = this.lo;
        this.merging = true;
      }
      for (let budget = chunk; budget > 0 && this.k < this.hi; budget--) {
        if (this.i < this.mid && (this.j >= this.hi || this.cmp(src[this.i], src[this.j]) <= 0)) dst[this.k++] = src[this.i++];
        else dst[this.k++] = src[this.j++];
      }
      if (this.k >= this.hi) {
        this.merging = false;
        this.lo += 2 * this.width;
        if (this.lo >= n) {
          // A whole pass is written: the destination becomes the source of the next one.
          this.src = dst; this.dst = src;
          this.width *= 2; this.lo = 0;
          if (this.width >= n) this.phase = 'done';
        }
      }
    }
    return this.done;
  }

  /** The sorted indices; only valid once `step` returned true. */
  result(): Int32Array { return this.src; }
}
