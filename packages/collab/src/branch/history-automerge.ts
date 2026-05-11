/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Automerge-backed `HistorySidecar` (spec §4 + §12.4).
 *
 * Same interface as `MemoryHistorySidecar`, but every entry lives
 * inside an Automerge document. That gives us:
 *   - first-class branching / merging at the storage layer
 *   - a binary `save()` representation we can persist
 *   - cheap time-travel via Automerge `view(heads)` and `getHistory()`
 *
 * The trade-off (per spec §4) is bundle size: Automerge is Rust+WASM.
 * For deployments where that's unacceptable, `MemoryHistorySidecar`
 * remains the default. Both satisfy `HistorySidecar`.
 */

import * as A from '@automerge/automerge';
import type { IfcxFile } from '@ifc-lite/ifcx';
import type {
  BranchInfo,
  HistoryDiff,
  HistoryEntry,
  HistorySidecar,
} from './history.js';

interface AutomergeShape extends Record<string, unknown> {
  /** entryId → entry payload (snapshot kept as JSON string for size). */
  entries: Record<string, AutomergeEntry>;
  /** branch name → branch info */
  branches: Record<string, BranchInfo>;
  /** branch name → ordered list of entryIds */
  byBranch: Record<string, string[]>;
}

interface AutomergeEntry {
  entryId: string;
  at: string;
  branch: string;
  authorClientId?: number;
  label?: string;
  /** JSON-stringified IFCX so Automerge keeps it as one scalar. */
  snapshotJson: string;
  /** JSON-stringified diff IFCX (optional). */
  diffJson?: string;
  /** Immutable merge metadata — see `HistoryEntry` doc comment. */
  mergedFromBranch?: string;
  mergedFromEntryId?: string;
}

export interface AutomergeHistorySidecarOptions {
  /** Restore from a previously-saved binary doc. */
  serialised?: Uint8Array;
}

export class AutomergeHistorySidecar implements HistorySidecar {
  private doc: A.Doc<AutomergeShape>;
  private counter = 0;

  constructor(opts: AutomergeHistorySidecarOptions = {}) {
    if (opts.serialised && opts.serialised.byteLength > 0) {
      this.doc = A.load<AutomergeShape>(opts.serialised);
      // Recompute counter so newly-recorded ids don't collide.
      const ids = Object.keys((this.doc as unknown as AutomergeShape).entries ?? {});
      this.counter = ids.length;
    } else {
      this.doc = A.from<AutomergeShape>({
        entries: {},
        branches: {
          main: { name: 'main', createdAt: new Date().toISOString() },
        },
        byBranch: { main: [] },
      });
    }
  }

  /** Serialise the entire history doc. Use to persist across restarts. */
  save(): Uint8Array {
    return A.save(this.doc);
  }

  /** Replace the internal doc. Used by tests + restore flows. */
  load(serialised: Uint8Array): void {
    this.doc = A.load<AutomergeShape>(serialised);
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
    const entryId = this.nextEntryId();
    const at = new Date().toISOString();
    const snapshotJson = JSON.stringify(input.snapshot);
    const diffJson = input.diff ? JSON.stringify(input.diff) : undefined;

    this.doc = A.change(this.doc, `record ${entryId}`, (d) => {
      if (!d.branches[branch]) {
        d.branches[branch] = { name: branch, createdAt: at };
        d.byBranch[branch] = [];
      }
      // Automerge rejects `undefined` — only set defined fields.
      const entry: Record<string, unknown> = { entryId, at, branch, snapshotJson };
      if (input.authorClientId !== undefined) entry.authorClientId = input.authorClientId;
      if (input.label !== undefined) entry.label = input.label;
      if (diffJson !== undefined) entry.diffJson = diffJson;
      d.entries[entryId] = entry as unknown as AutomergeEntry;
      d.byBranch[branch].push(entryId);
    });

    return revive({
      entryId,
      at,
      branch,
      authorClientId: input.authorClientId,
      label: input.label,
      snapshotJson,
      diffJson,
    });
  }

  async entries(branch?: string): Promise<HistoryEntry[]> {
    const shape = this.doc as unknown as AutomergeShape;
    if (branch) {
      const ids = shape.byBranch[branch] ?? [];
      return ids
        .map((id) => shape.entries[id])
        .filter((e): e is AutomergeEntry => Boolean(e))
        .map(revive);
    }
    return Object.values(shape.entries)
      .map(revive)
      .sort((a, b) => a.at.localeCompare(b.at));
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
    const shape = this.doc as unknown as AutomergeShape;
    const from = shape.entries[fromEntryId];
    const to = shape.entries[toEntryId];
    if (!from || !to) {
      return { from: fromEntryId, to: toEntryId, added: [], removed: [], changed: [] };
    }
    const fromIfcx = JSON.parse(from.snapshotJson) as IfcxFile;
    const toIfcx = JSON.parse(to.snapshotJson) as IfcxFile;

    const fromPaths = new Map<string, unknown>();
    const toPaths = new Map<string, unknown>();
    for (const n of fromIfcx.data ?? []) fromPaths.set(n.path, n);
    for (const n of toIfcx.data ?? []) toPaths.set(n.path, n);

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
    const shape = this.doc as unknown as AutomergeShape;
    return Object.values(shape.branches).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async branch(name: string, fromEntryId?: string): Promise<BranchInfo> {
    const shape = this.doc as unknown as AutomergeShape;
    if (shape.branches[name]) {
      throw new Error(`@ifc-lite/collab: branch "${name}" already exists`);
    }
    // Default fork point = current head of main when no explicit
    // entry is supplied, matching `MemoryHistorySidecar` + the documented
    // interface.
    let resolvedFork = fromEntryId;
    if (!resolvedFork) {
      const mainIds = shape.byBranch.main ?? [];
      resolvedFork = mainIds[mainIds.length - 1];
    }
    const info: BranchInfo = {
      name,
      forkedFromEntryId: resolvedFork,
      createdAt: new Date().toISOString(),
    };
    this.doc = A.change(this.doc, `branch ${name}`, (d) => {
      const stored: Record<string, unknown> = { name, createdAt: info.createdAt };
      if (resolvedFork !== undefined) stored.forkedFromEntryId = resolvedFork;
      d.branches[name] = stored as unknown as BranchInfo;
      d.byBranch[name] = [];
    });
    return info;
  }

  async merge(
    branch: string,
    into: string,
    mergedSnapshot: IfcxFile,
  ): Promise<HistoryEntry> {
    const shape = this.doc as unknown as AutomergeShape;
    // Validate the source branch up front (matches MemoryHistorySidecar).
    if (!shape.branches[branch]) {
      throw new Error(`@ifc-lite/collab: source branch "${branch}" not found`);
    }
    if (!shape.branches[into]) {
      throw new Error(`@ifc-lite/collab: target branch "${into}" not found`);
    }
    const sourceIds = shape.byBranch[branch] ?? [];
    const sourceTipId = sourceIds[sourceIds.length - 1];
    const entryId = this.nextEntryId();
    const at = new Date().toISOString();
    const snapshotJson = JSON.stringify(mergedSnapshot);
    const label = `merge ${branch} → ${into}`;
    this.doc = A.change(this.doc, `merge ${branch} → ${into}`, (d) => {
      // Automerge rejects `undefined` — only set defined fields.
      const entry: Record<string, unknown> = {
        entryId,
        at,
        branch: into,
        label,
        snapshotJson,
        mergedFromBranch: branch,
      };
      if (sourceTipId !== undefined) entry.mergedFromEntryId = sourceTipId;
      d.entries[entryId] = entry as unknown as AutomergeEntry;
      d.byBranch[into].push(entryId);
    });
    return revive({
      entryId,
      at,
      branch: into,
      label,
      snapshotJson,
      mergedFromBranch: branch,
      mergedFromEntryId: sourceTipId,
    });
  }

  async clear(): Promise<void> {
    this.doc = A.from<AutomergeShape>({
      entries: {},
      branches: { main: { name: 'main', createdAt: new Date().toISOString() } },
      byBranch: { main: [] },
    });
    this.counter = 0;
  }
}

function revive(entry: AutomergeEntry): HistoryEntry {
  return {
    entryId: entry.entryId,
    at: entry.at,
    branch: entry.branch,
    authorClientId: entry.authorClientId,
    label: entry.label,
    snapshot: JSON.parse(entry.snapshotJson) as IfcxFile,
    diff: entry.diffJson ? (JSON.parse(entry.diffJson) as IfcxFile) : undefined,
    mergedFromBranch: entry.mergedFromBranch,
    mergedFromEntryId: entry.mergedFromEntryId,
  };
}
