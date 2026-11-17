/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A room's persistence writes, one at a time and bounded (#9489).
 *
 * Compaction REPLACES the persisted log (FilePersistence tmp + rename, Redis
 * SET + LTRIM, S3 PUT + delete), so two writes in flight can roll the log
 * back: an older periodic compaction landing after a newer one, or after a
 * reloaded instance appended. So at most one write runs per room.
 *
 * Serializing alone would let a burst queue one append per update behind a
 * slow backend (an S3 compaction takes seconds), growing memory and the
 * unpersisted window without bound. Updates that arrive while a write runs
 * are therefore merged into ONE pending append (`Y.mergeUpdates`, never byte
 * concatenation; see AGENTS.md). Closing drops that pending append: the final
 * compaction is taken from the doc, which already contains it.
 */

import * as Y from 'yjs';
import type { Persistence } from './persistence.js';

export interface RoomWriterOptions {
  roomId: string;
  persistence: Persistence;
  /** Compact after this many updates have been appended. */
  compactEvery: number;
  /** The room doc's full state, for compactions. */
  snapshot: () => Uint8Array;
}

export class RoomWriter {
  private pending: Uint8Array | null = null;
  private pendingCount = 0;
  private sinceCompact = 0;
  private active: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly opts: RoomWriterOptions) {}

  /** Persist `update`: now if idle, else merged into the one pending append. */
  enqueue(update: Uint8Array): void {
    if (this.closed) return; // the final compaction carries it
    this.pending = this.pending ? Y.mergeUpdates([this.pending, update]) : update;
    this.pendingCount++;
    this.active ??= this.drain();
  }

  /**
   * Stop accepting writes, drop the pending append, wait for the write in
   * flight, then write the final compaction. If that compaction fails, the
   * full state is appended instead so the dropped updates still reach disk.
   */
  async closeAndCompact(): Promise<void> {
    this.closed = true;
    this.pending = null;
    await this.active;
    const { roomId, persistence } = this.opts;
    const state = this.opts.snapshot();
    try {
      await persistence.compact(roomId, state);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[collab-server] compact-on-destroy error for ${roomId}; appending full state instead:`, err);
      try {
        await persistence.append(roomId, state);
      } catch (appendErr) {
        // eslint-disable-next-line no-console
        console.error(`[collab-server] fallback append failed for ${roomId}; recent updates are not on disk:`, appendErr);
      }
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) { // closeAndCompact() nulls it
        const update = this.pending;
        const count = this.pendingCount;
        this.pending = null;
        this.pendingCount = 0;
        await this.writeOne(update, count);
      }
    } finally {
      this.active = null;
    }
  }

  private async writeOne(update: Uint8Array, count: number): Promise<void> {
    const { roomId, persistence, compactEvery, snapshot } = this.opts;
    try {
      await persistence.append(roomId, update);
      this.sinceCompact += count;
      if (this.sinceCompact >= compactEvery) {
        await persistence.compact(roomId, snapshot());
        this.sinceCompact = 0;
      }
    } catch (err) {
      // Persistence failures are logged but never block sync — the
      // in-memory state is still consistent across peers, and the next
      // successful append/compact catches up.
      // eslint-disable-next-line no-console
      console.error(`[collab-server] persistence error for room ${roomId}:`, err);
    }
  }
}
