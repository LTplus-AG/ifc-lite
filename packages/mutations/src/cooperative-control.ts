/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { EntityPreparationOptions } from './cooperative-operation-types.js';

export class CooperativeControl {
  private work = 0;
  private bytes = 0;
  private sliceWork = 0;
  private deadline = 0;
  private readonly maxWork: number;
  private readonly maxBytes: number;
  private readonly sliceMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly yieldTask: () => Promise<void>;

  constructor(options: EntityPreparationOptions) {
    this.signal = options.signal;
    this.maxWork = options.maxWork ?? 16_000_000;
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    this.sliceMs = options.maxSliceMs ?? 4;
    if (!Number.isSafeInteger(this.maxWork) || this.maxWork <= 0
      || !Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0
      || !Number.isFinite(this.sliceMs) || this.sliceMs <= 0) {
      throw new RangeError('Cooperative preparation budgets must be finite and positive.');
    }
    this.yieldTask = options.yieldTask ?? (() => new Promise(resolve => setTimeout(resolve, 0)));
    this.deadline = performance.now() + this.sliceMs;
    this.checkAbort();
  }

  checkAbort(): void {
    if (this.signal?.aborted) throw new DOMException('Entity preparation was cancelled.', 'AbortError');
  }

  step(bytes = 0): boolean {
    this.checkAbort();
    this.work++;
    this.bytes += bytes;
    if (this.work > this.maxWork || this.bytes > this.maxBytes) {
      throw new RangeError('Entity preparation exceeds its work or allocation budget.');
    }
    if (++this.sliceWork >= 256 && (this.sliceWork >= 4096 || performance.now() >= this.deadline)) {
      return true;
    }
    return false;
  }

  async pause(): Promise<void> {
    this.checkAbort();
    const signal = this.signal;
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(new DOMException('Entity preparation was cancelled.', 'AbortError'));
        signal?.addEventListener('abort', onAbort, { once: true });
        // Handle both a thrown scheduler error and abort inside the scheduler.
        try { Promise.resolve(this.yieldTask()).then(resolve, reject); }
        catch (error) { reject(error); }
      });
      this.checkAbort();
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
    this.sliceWork = 0;
    this.deadline = performance.now() + this.sliceMs;
  }
}
