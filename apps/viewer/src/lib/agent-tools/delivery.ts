/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface DeliveryClaim {
  deliver(): void;
  drop(): void;
}

/** Several callers can hold claims on one result. Each claim settles once. */
export class ResultDelivery {
  private readonly claims = new Set<{ signal?: AbortSignal }>();
  private delivered = false;

  constructor(private readonly onDelivery: () => void, private readonly onUnclaimed: () => void) {}

  get pending(): boolean { return !this.delivered && this.claims.size > 0; }

  /** During execution a caller's abort can precede dispatch's claim settlement. */
  get hasActiveCaller(): boolean {
    for (const { signal } of this.claims) if (!signal?.aborted) return true;
    return false;
  }

  claim(signal?: AbortSignal): DeliveryClaim {
    if (this.delivered) return { deliver() {}, drop() {} };
    const caller = { signal };
    this.claims.add(caller);
    const settle = (delivered: boolean) => {
      if (!this.claims.delete(caller)) return;
      if (this.delivered) return;
      if (delivered) {
        this.delivered = true;
        this.onDelivery();
      } else if (!this.pending) {
        this.onUnclaimed();
      }
    };
    return { deliver: () => settle(true), drop: () => settle(false) };
  }
}
