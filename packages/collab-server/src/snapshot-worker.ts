/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Server-driven IFCX snapshot worker (spec §12.3).
 *
 * Periodically exports each active room's Y.Doc as an `.ifcx` file
 * (composed state), optionally with per-user "git blame" layers. Output
 * lives next to the durable update log so a deployment can ship its
 * audit chain alongside its persistence.
 *
 * Runs as a self-contained class — instantiate with a `RoomManager`
 * handle and call `start()`. The worker is stateless across restarts;
 * the room itself is the source of truth.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { snapshotToIfcx, serializeIfcx } from '@ifc-lite/collab';
import type { RoomManager } from './room-manager.js';

export interface SnapshotWorkerOptions {
  roomManager: RoomManager;
  /** Output directory; created if missing. */
  outputDir: string;
  /** How often to run snapshots, ms. Default 5 minutes. */
  intervalMs?: number;
  /** If true, also emit a per-clientID layer file alongside the composed snapshot. */
  emitLayers?: boolean;
  /** Override clock so tests are deterministic. */
  now?: () => number;
  /** If true, snapshot even rooms with zero peers (default false). */
  includeIdle?: boolean;
}

export interface SnapshotResult {
  roomId: string;
  filePath: string;
  byteLength: number;
  durationMs: number;
}

export class SnapshotWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<SnapshotResult[]> | null = null;
  private readonly options: Required<Omit<SnapshotWorkerOptions, 'roomManager' | 'now' | 'emitLayers' | 'includeIdle'>> &
    Pick<SnapshotWorkerOptions, 'roomManager' | 'now' | 'emitLayers' | 'includeIdle'>;

  constructor(opts: SnapshotWorkerOptions) {
    this.options = {
      roomManager: opts.roomManager,
      outputDir: opts.outputDir,
      intervalMs: opts.intervalMs ?? 5 * 60_000,
      emitLayers: opts.emitLayers ?? false,
      now: opts.now,
      includeIdle: opts.includeIdle,
    };
    fs.mkdirSync(this.options.outputDir, { recursive: true });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[snapshot-worker] run failed:', err);
      });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Force one snapshot pass across all active rooms. Returns per-room results. */
  async runOnce(): Promise<SnapshotResult[]> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const stats = await this.options.roomManager.stats();
      const targets = stats.filter((s) => s.peerCount > 0 || this.options.includeIdle);
      const results: SnapshotResult[] = [];
      for (const t of targets) {
        const room = await this.options.roomManager.getOrCreate(t.roomId);
        const start = this.now();
        const ifcx = snapshotToIfcx(room.doc);
        const content = serializeIfcx(ifcx, false);
        const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
        const safe = t.roomId.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = path.join(this.options.outputDir, `${safe}.${stamp}.ifcx`);
        await fs.promises.writeFile(filePath, content);
        results.push({
          roomId: t.roomId,
          filePath,
          byteLength: Buffer.byteLength(content, 'utf8'),
          durationMs: this.now() - start,
        });
      }
      return results;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
