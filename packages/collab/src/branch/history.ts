/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * History sidecar (spec §4 + §12.4).
 *
 * The Yjs runtime is optimized for live editing — it doesn't ship a
 * first-class history / branch / time-travel UI. Per spec §4, we run an
 * Automerge-shaped sidecar that records periodic snapshots of the live
 * doc so apps can navigate `(branch, timestamp)` space.
 *
 * To avoid forcing every consumer to take the heavy `@automerge/automerge`
 * Rust+WASM dep, this module ships:
 *
 *   - `HistorySidecar` interface — `record(snapshot)`, `entries()`,
 *     `at(t)`, `diff(a, b)`, `branches()`, `branch(name, fromEntryId)`,
 *     `merge(branch, into)`.
 *   - `MemoryHistorySidecar` — keeps every snapshot + per-entry diff
 *     in RAM. Good for tests and short-lived sessions.
 *   - `IndexedDbHistorySidecar` — same shape, persisted to IDB.
 *   - `attachHistorySidecar(session, sidecar, opts)` — drives a sidecar
 *     from a `CollabSession` by snapshotting on a timer and on demand.
 *
 * A future `AutomergeHistorySidecar` (pending the heavy dep) will
 * satisfy the same interface.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import type { CollabSession } from '../session.js';
import { snapshotToIfcx, type SnapshotOptions } from '../snapshot/to-ifcx.js';
import { extractMinimalLayer } from '../snapshot/minimal-layer.js';
import * as Y from 'yjs';

export interface HistoryEntry {
  /** Stable id (UUIDv4-like or timestamp-based). */
  entryId: string;
  /** ISO timestamp. */
  at: string;
  /** Branch this entry belongs to. */
  branch: string;
  /** clientID of the author at snapshot time, if known. */
  authorClientId?: number;
  /** Free-form label (commit-message-style). */
  label?: string;
  /** Composed IFCX snapshot — full state at this entry. */
  snapshot: IfcxFile;
  /** Optional minimal layer relative to the previous entry on this branch. */
  diff?: IfcxFile;
}

export interface HistoryDiff {
  /** Entry IDs of `from` and `to`. */
  from: string;
  to: string;
  /**
   * Per-entity differences as observed by walking IFCX nodes:
   *   - `added`     — entity exists in `to` but not in `from`
   *   - `removed`   — entity exists in `from` but not in `to`
   *   - `changed`   — both, with at least one attribute / child differing
   */
  added: string[];
  removed: string[];
  changed: string[];
}

export interface BranchInfo {
  name: string;
  /** entryId on the parent branch where this branch forked. */
  forkedFromEntryId?: string;
  /** Wall-clock time of branch creation. */
  createdAt: string;
}

export interface HistorySidecar {
  /** Append a new entry to a branch (default `'main'`). */
  record(input: {
    branch?: string;
    label?: string;
    snapshot: IfcxFile;
    diff?: IfcxFile;
    authorClientId?: number;
  }): Promise<HistoryEntry>;
  /** All entries, oldest first, optionally filtered to one branch. */
  entries(branch?: string): Promise<HistoryEntry[]>;
  /** The entry whose `at` is closest to (and not after) `at`. */
  at(at: Date | string, branch?: string): Promise<HistoryEntry | null>;
  /** Per-entity-id diff between two entries. */
  diff(fromEntryId: string, toEntryId: string): Promise<HistoryDiff>;
  /** All known branches, in creation order. */
  branches(): Promise<BranchInfo[]>;
  /** Create a new branch off `fromEntryId` (defaults to head of `main`). */
  branch(name: string, fromEntryId?: string): Promise<BranchInfo>;
  /**
   * Merge `branch` into `into`. Returns a synthetic merge entry — apps
   * compute the merged snapshot themselves (typically by replaying
   * Y-update logs through `mergeBranch`).
   */
  merge(branch: string, into: string, mergedSnapshot: IfcxFile): Promise<HistoryEntry>;
  /** Remove all entries / branches. */
  clear(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* In-memory implementation                                            */
/* ------------------------------------------------------------------ */

export class MemoryHistorySidecar implements HistorySidecar {
  private readonly entriesByBranch = new Map<string, HistoryEntry[]>();
  private readonly branchInfo = new Map<string, BranchInfo>();
  private counter = 0;

  constructor() {
    this.branchInfo.set('main', {
      name: 'main',
      createdAt: new Date().toISOString(),
    });
    this.entriesByBranch.set('main', []);
  }

  private nextEntryId(): string {
    this.counter += 1;
    return `e${this.counter}-${Date.now().toString(36)}`;
  }

  async record(input: {
    branch?: string;
    label?: string;
    snapshot: IfcxFile;
    diff?: IfcxFile;
    authorClientId?: number;
  }): Promise<HistoryEntry> {
    const branch = input.branch ?? 'main';
    if (!this.branchInfo.has(branch)) {
      this.branchInfo.set(branch, { name: branch, createdAt: new Date().toISOString() });
      this.entriesByBranch.set(branch, []);
    }
    const entry: HistoryEntry = {
      entryId: this.nextEntryId(),
      at: new Date().toISOString(),
      branch,
      authorClientId: input.authorClientId,
      label: input.label,
      snapshot: input.snapshot,
      diff: input.diff,
    };
    const arr = this.entriesByBranch.get(branch)!;
    arr.push(entry);
    return entry;
  }

  async entries(branch?: string): Promise<HistoryEntry[]> {
    if (branch) return [...(this.entriesByBranch.get(branch) ?? [])];
    const all: HistoryEntry[] = [];
    for (const arr of this.entriesByBranch.values()) all.push(...arr);
    return all.sort((a, b) => a.at.localeCompare(b.at));
  }

  async at(at: Date | string, branch?: string): Promise<HistoryEntry | null> {
    const target = at instanceof Date ? at.toISOString() : at;
    const list = await this.entries(branch);
    let best: HistoryEntry | null = null;
    for (const e of list) {
      if (e.at <= target) best = e;
      else break;
    }
    return best;
  }

  async diff(fromEntryId: string, toEntryId: string): Promise<HistoryDiff> {
    const all = await this.entries();
    const from = all.find((e) => e.entryId === fromEntryId);
    const to = all.find((e) => e.entryId === toEntryId);
    if (!from || !to) {
      return { from: fromEntryId, to: toEntryId, added: [], removed: [], changed: [] };
    }
    const fromPaths = new Map<string, unknown>();
    const toPaths = new Map<string, unknown>();
    for (const n of from.snapshot.data ?? []) fromPaths.set(n.path, n);
    for (const n of to.snapshot.data ?? []) toPaths.set(n.path, n);

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const path of toPaths.keys()) {
      if (!fromPaths.has(path)) added.push(path);
      else if (JSON.stringify(toPaths.get(path)) !== JSON.stringify(fromPaths.get(path))) {
        changed.push(path);
      }
    }
    for (const path of fromPaths.keys()) {
      if (!toPaths.has(path)) removed.push(path);
    }
    return {
      from: fromEntryId,
      to: toEntryId,
      added: added.sort(),
      removed: removed.sort(),
      changed: changed.sort(),
    };
  }

  async branches(): Promise<BranchInfo[]> {
    return Array.from(this.branchInfo.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async branch(name: string, fromEntryId?: string): Promise<BranchInfo> {
    if (this.branchInfo.has(name)) {
      throw new Error(`@ifc-lite/collab: branch "${name}" already exists`);
    }
    const info: BranchInfo = {
      name,
      forkedFromEntryId: fromEntryId,
      createdAt: new Date().toISOString(),
    };
    this.branchInfo.set(name, info);
    this.entriesByBranch.set(name, []);
    return info;
  }

  async merge(
    branch: string,
    into: string,
    mergedSnapshot: IfcxFile,
  ): Promise<HistoryEntry> {
    const targetEntries = this.entriesByBranch.get(into);
    if (!targetEntries) {
      throw new Error(`@ifc-lite/collab: target branch "${into}" not found`);
    }
    const entry: HistoryEntry = {
      entryId: this.nextEntryId(),
      at: new Date().toISOString(),
      branch: into,
      label: `merge ${branch} → ${into}`,
      snapshot: mergedSnapshot,
    };
    targetEntries.push(entry);
    return entry;
  }

  async clear(): Promise<void> {
    this.entriesByBranch.clear();
    this.branchInfo.clear();
    this.branchInfo.set('main', { name: 'main', createdAt: new Date().toISOString() });
    this.entriesByBranch.set('main', []);
    this.counter = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Session driver                                                      */
/* ------------------------------------------------------------------ */

export interface AttachHistoryOptions {
  /** How often to record a snapshot, ms. Default 60_000. */
  intervalMs?: number;
  /** Branch to record on. Default 'main'. */
  branch?: string;
  /** Forwarded to `snapshotToIfcx`. */
  snapshot?: SnapshotOptions;
  /**
   * If true (default), include a minimal-layer diff against the
   * previous entry on the same branch. Diffs make `historySidecar.diff(a, b)`
   * cheaper to compute.
   */
  includeDiff?: boolean;
}

export interface HistoryDriver {
  /** Force a snapshot now. */
  capture(label?: string): Promise<HistoryEntry>;
  /** Stop the timer. */
  detach(): void;
}

/**
 * Drive a `HistorySidecar` from a live `CollabSession`. Records a
 * snapshot every `intervalMs`, plus on-demand via `capture(label)`.
 */
export function attachHistorySidecar(
  session: CollabSession,
  sidecar: HistorySidecar,
  options: AttachHistoryOptions = {},
): HistoryDriver {
  const intervalMs = options.intervalMs ?? 60_000;
  const branch = options.branch ?? 'main';
  const includeDiff = options.includeDiff ?? true;

  let lastBaseline: Uint8Array | null = null;

  const capture = async (label?: string): Promise<HistoryEntry> => {
    const ifcx = snapshotToIfcx(session.doc, options.snapshot);
    const diff =
      includeDiff && lastBaseline
        ? extractMinimalLayer(session.doc, lastBaseline, { snapshot: options.snapshot })
        : undefined;
    lastBaseline = Y.encodeStateAsUpdate(session.doc);
    return sidecar.record({
      branch,
      snapshot: ifcx,
      diff,
      label,
      authorClientId: session.clientId,
    });
  };

  const timer = setInterval(() => {
    void capture().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[collab] history capture failed:', err);
    });
  }, intervalMs);
  // Don't keep Node alive solely for this timer.
  timer.unref?.();

  return {
    capture,
    detach() {
      clearInterval(timer);
    },
  };
}
