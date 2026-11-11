/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `has` calls answered by binary search before the membership bitset is built. */
const MEMBERSHIP_AFTER_LOOKUPS = 256;
/** Largest express id a membership bitset covers (32 MiB of bits). */
const MEMBERSHIP_MAX_ID = 256 * 1024 * 1024;
/** Id range per indexed entity above which the bitset would be mostly empty. */
const MEMBERSHIP_MAX_SPARSITY = 64;

/**
 * Membership of a sorted express-id column as a bitset over the id range, built
 * on the `MEMBERSHIP_AFTER_LOOKUPS`-th query. Relationship queries filter every
 * related id through `CompactEntityIndex.has` (millions of calls while a
 * hierarchy renders), and a binary search per call was ~0.1 s of a large
 * model's reopen. `has` answers undefined (the caller binary searches) until
 * then, for an id range too sparse for a bitset, and once the column has been
 * detached (transport), where the binary search answers false as before.
 */
export class LazyMembership {
  /** undefined until built or refused, null when refused. */
  private present: Uint32Array | null | undefined;
  private lookups = 0;
  private maxId = 0;
  private readonly size: number;

  constructor(private readonly ids: Uint32Array) {
    this.size = ids.length;
  }

  has(expressId: number): boolean | undefined {
    const present = this.bitset();
    if (present === null) return undefined;
    // `>>> 0` keeps exactly the uint32 ids the column can hold (no fractions, negatives or > 2^32-1).
    return (expressId >>> 0) === expressId && expressId <= this.maxId && (present[expressId >>> 5] & (1 << (expressId & 31))) !== 0;
  }

  private bitset(): Uint32Array | null {
    if (this.ids.length !== this.size) return null;
    if (this.present !== undefined) return this.present;
    if (++this.lookups < MEMBERSHIP_AFTER_LOOKUPS) return null;
    const max = this.size > 0 ? this.ids[this.size - 1] : 0;
    if (this.size === 0 || max > MEMBERSHIP_MAX_ID || max > this.size * MEMBERSHIP_MAX_SPARSITY) return (this.present = null);
    const present = new Uint32Array((max >>> 5) + 1);
    for (let i = 0; i < this.size; i++) {
      const id = this.ids[i];
      present[id >>> 5] |= 1 << (id & 31);
    }
    this.maxId = max;
    return (this.present = present);
  }
}
