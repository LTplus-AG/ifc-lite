/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Audit log writer.
 *
 * In-memory append-only ring buffer with two caps:
 *   - max event count (default 10,000)
 *   - max total bytes of JSON encoding (default 10 MiB)
 *
 * The viewer/desktop hosts persist the log to IndexedDB / disk via a
 * thin adapter; this module is host-agnostic and operates purely on
 * the in-memory structure. Eviction is FIFO: when either cap is
 * exceeded, the oldest events are dropped until both caps are
 * respected.
 *
 * Spec: docs/architecture/ai-customization/02-security.md §12.
 */

import type { AuditEvent, AuditFilter, AuditEventKind } from './types.js';

/**
 * Distributive Omit — preserves discriminated-union narrowing across
 * `Omit`. `Omit<A | B, 'k'>` collapses to `Omit<A | B, 'k'>` (no
 * distribution); `DistributiveOmit<A | B, 'k'>` yields
 * `Omit<A, 'k'> | Omit<B, 'k'>` which keeps each branch's unique
 * fields visible.
 */
type DistributiveOmit<T, K extends keyof T | string> = T extends unknown
  ? Omit<T, K & keyof T>
  : never;

/** Shape callers pass to `append()`. The seq is always assigned by the
 * log; `ts` may be supplied for tests and is otherwise stamped from
 * the configured clock. */
export type AuditEventInput = DistributiveOmit<AuditEvent, 'seq' | 'ts'> & {
  ts?: string;
};

export interface AuditLogOptions {
  /** Maximum number of events retained. Default 10,000. */
  maxEvents?: number;
  /** Maximum total bytes (JSON-encoded) retained. Default 10 MiB. */
  maxBytes?: number;
  /** Optional clock for deterministic tests. Defaults to Date.now. */
  now?: () => Date;
}

const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export class AuditLog {
  private events: AuditEvent[] = [];
  /** Tracks the JSON byte size of each event in parallel with `events`. */
  private sizes: number[] = [];
  private nextSeq = 1;
  private totalBytes = 0;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(opts: AuditLogOptions = {}) {
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Append an event. `seq` and `ts` are assigned by the log; any
   * caller-supplied values are overwritten. The input type uses
   * distributive Omit so each event-kind's unique fields stay visible
   * to TypeScript (no need for `as` casts at call sites).
   */
  append(event: AuditEventInput): AuditEvent {
    const stamped = {
      ...event,
      seq: this.nextSeq,
      ts: this.now().toISOString(),
    } as AuditEvent;
    this.nextSeq += 1;
    const encoded = JSON.stringify(stamped);
    this.events.push(stamped);
    this.sizes.push(encoded.length);
    this.totalBytes += encoded.length;
    this.evict();
    return stamped;
  }

  /** List events matching the filter, oldest first. */
  list(filter: AuditFilter = {}): AuditEvent[] {
    return this.events.filter((e) => {
      if (filter.extensionId && e.extensionId !== filter.extensionId) return false;
      if (filter.kind && e.kind !== filter.kind) return false;
      if (filter.sinceSeq !== undefined && e.seq < filter.sinceSeq) return false;
      if (filter.untilSeq !== undefined && e.seq > filter.untilSeq) return false;
      return true;
    });
  }

  /** Counter snapshot by kind — useful for dashboards. */
  countByKind(filter: AuditFilter = {}): Record<AuditEventKind, number> {
    const counts: Partial<Record<AuditEventKind, number>> = {};
    for (const e of this.list(filter)) {
      counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    }
    return counts as Record<AuditEventKind, number>;
  }

  /** Export the entire log as a pretty-printed JSON string. */
  exportJson(): string {
    return JSON.stringify({
      version: 1,
      generatedAt: this.now().toISOString(),
      events: this.events,
    }, null, 2);
  }

  /** Approximate in-memory footprint, in JSON bytes. */
  byteSize(): number {
    return this.totalBytes;
  }

  /** Current event count. */
  size(): number {
    return this.events.length;
  }

  /** Reset everything. */
  clear(): void {
    this.events = [];
    this.sizes = [];
    this.totalBytes = 0;
    // We intentionally do not reset `nextSeq` so seqs remain unique
    // across clears within a session.
  }

  private evict(): void {
    while (
      (this.events.length > this.maxEvents || this.totalBytes > this.maxBytes) &&
      this.events.length > 0
    ) {
      this.events.shift();
      const size = this.sizes.shift() ?? 0;
      this.totalBytes -= size;
    }
  }
}
