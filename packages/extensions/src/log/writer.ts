/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Action log writer.
 *
 * Append-only rolling buffer with both a count cap and a byte cap.
 * Mirrors `AuditLog` but logs user intents (for pattern mining and
 * memory extraction) rather than security-relevant lifecycle events.
 *
 * Privacy: only the params declared in `ActionParams[intent]` are
 * recorded. Callers are expected to project content-free metadata
 * before calling `append`. The log never sees raw model content,
 * chat content, file paths, or BYOK keys.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §2.
 */

import type { ActionEvent, ActionFilter, ActionIntent, ActionParams } from './types.js';

export interface ActionLogOptions {
  /** Max event count retained. Default 50,000. */
  maxEvents?: number;
  /** Max bytes (UTF-8 of JSON). Default 8 MiB. */
  maxBytes?: number;
  /** Optional clock for tests. */
  now?: () => Date;
}

const DEFAULT_MAX_EVENTS = 50_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const ENCODER = new TextEncoder();

export type AppendInput<K extends ActionIntent> = {
  intent: K;
  params: ActionParams[K];
  success?: boolean;
  durationMs?: number;
};

export class ActionLog {
  private events: ActionEvent[] = [];
  private sizes: number[] = [];
  private totalBytes = 0;
  private nextSeq = 1;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private listeners = new Set<(event: ActionEvent) => void>();

  constructor(opts: ActionLogOptions = {}) {
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Append an action event. `seq` and `ts` are assigned by the log.
   * `success` defaults to true. The generic preserves discriminated-
   * union narrowing on `params`.
   */
  append<K extends ActionIntent>(input: AppendInput<K>): ActionEvent {
    const stamped = {
      seq: this.nextSeq,
      ts: this.now().toISOString(),
      intent: input.intent,
      params: input.params,
      success: input.success ?? true,
      durationMs: input.durationMs,
    } as ActionEvent;
    this.nextSeq += 1;
    const byteSize = ENCODER.encode(JSON.stringify(stamped)).byteLength;
    const frozen = deepFreeze(stamped);
    this.events.push(frozen);
    this.sizes.push(byteSize);
    this.totalBytes += byteSize;
    this.evict();
    for (const listener of this.listeners) listener(frozen);
    return frozen;
  }

  list(filter: ActionFilter = {}): ActionEvent[] {
    return this.events.filter((e) => {
      if (filter.intent && e.intent !== filter.intent) return false;
      if (filter.sinceSeq !== undefined && e.seq < filter.sinceSeq) return false;
      if (filter.untilSeq !== undefined && e.seq > filter.untilSeq) return false;
      if (filter.sinceTs !== undefined && e.ts < filter.sinceTs) return false;
      return true;
    });
  }

  /** Subscribe to new events (fire after append). Returns unsubscribe. */
  subscribe(listener: (event: ActionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  countByIntent(filter: ActionFilter = {}): Record<ActionIntent, number> {
    const counts: Partial<Record<ActionIntent, number>> = {};
    for (const e of this.list(filter)) {
      counts[e.intent] = (counts[e.intent] ?? 0) + 1;
    }
    return counts as Record<ActionIntent, number>;
  }

  exportJson(): string {
    return JSON.stringify({
      version: 1,
      generatedAt: this.now().toISOString(),
      events: this.events,
    }, null, 2);
  }

  size(): number {
    return this.events.length;
  }

  byteSize(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.events = [];
    this.sizes = [];
    this.totalBytes = 0;
    // seq intentionally preserved across clears.
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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const v = (value as Record<string, unknown>)[key];
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(value);
}
