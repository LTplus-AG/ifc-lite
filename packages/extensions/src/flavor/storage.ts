/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flavor storage abstraction with an in-memory implementation.
 *
 * Mirrors the `ExtensionStorage` pattern so the package stays
 * host-agnostic. The viewer wraps IndexedDB behind this interface;
 * tests and the CLI use the in-memory implementation.
 *
 * Capabilities:
 *   - CRUD on flavors keyed by id
 *   - Active-flavor pointer (which flavor is loaded)
 *   - Auto-snapshot on every write, capped at `snapshotCap`
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §2.
 */

import type { Flavor, FlavorSnapshot } from './types.js';

export interface FlavorStorage {
  putFlavor(flavor: Flavor, reason?: string): Promise<void>;
  getFlavor(id: string): Promise<Flavor | undefined>;
  listFlavors(): Promise<Flavor[]>;
  deleteFlavor(id: string): Promise<void>;

  /** The flavor id currently active. */
  getActiveId(): Promise<string | undefined>;
  setActiveId(id: string | undefined): Promise<void>;

  /** Snapshots — capped per flavor. Newest first. */
  listSnapshots(flavorId: string): Promise<FlavorSnapshot[]>;
  /** Restore the flavor to a snapshot. Writes the snapshot as the current state. */
  restoreSnapshot(flavorId: string, seq: number, reason?: string): Promise<Flavor | undefined>;

  clear(): Promise<void>;
}

export interface FlavorStorageOptions {
  /** Max snapshots retained per flavor. Defaults to 10. */
  snapshotCap?: number;
  /** Optional clock for deterministic tests. */
  now?: () => Date;
}

const DEFAULT_SNAPSHOT_CAP = 10;

export class InMemoryFlavorStorage implements FlavorStorage {
  private flavors = new Map<string, Flavor>();
  private snapshots = new Map<string, FlavorSnapshot[]>();
  private nextSeq = 1;
  private activeId?: string;
  private readonly snapshotCap: number;
  private readonly now: () => Date;

  constructor(opts: FlavorStorageOptions = {}) {
    this.snapshotCap = opts.snapshotCap ?? DEFAULT_SNAPSHOT_CAP;
    this.now = opts.now ?? (() => new Date());
  }

  async putFlavor(flavor: Flavor, reason?: string): Promise<void> {
    const previous = this.flavors.get(flavor.id);
    if (previous) this.recordSnapshot(previous, reason);
    this.flavors.set(flavor.id, deepClone(flavor));
  }

  async getFlavor(id: string): Promise<Flavor | undefined> {
    const f = this.flavors.get(id);
    return f ? deepClone(f) : undefined;
  }

  async listFlavors(): Promise<Flavor[]> {
    return Array.from(this.flavors.values()).map(deepClone);
  }

  async deleteFlavor(id: string): Promise<void> {
    this.flavors.delete(id);
    this.snapshots.delete(id);
    if (this.activeId === id) this.activeId = undefined;
  }

  async getActiveId(): Promise<string | undefined> {
    return this.activeId;
  }

  async setActiveId(id: string | undefined): Promise<void> {
    if (id !== undefined && !this.flavors.has(id)) {
      throw new Error(`Cannot activate unknown flavor: ${id}`);
    }
    this.activeId = id;
  }

  async listSnapshots(flavorId: string): Promise<FlavorSnapshot[]> {
    const list = this.snapshots.get(flavorId) ?? [];
    return list.map(deepClone);
  }

  async restoreSnapshot(
    flavorId: string,
    seq: number,
    reason?: string,
  ): Promise<Flavor | undefined> {
    const list = this.snapshots.get(flavorId);
    if (!list) return undefined;
    const snap = list.find((s) => s.seq === seq);
    if (!snap) return undefined;
    // Restoring is itself a write → snapshot the current state first.
    const current = this.flavors.get(flavorId);
    if (current) this.recordSnapshot(current, reason ?? `before restore to seq ${seq}`);
    const restored = deepClone(snap.flavor);
    this.flavors.set(flavorId, restored);
    return deepClone(restored);
  }

  async clear(): Promise<void> {
    this.flavors.clear();
    this.snapshots.clear();
    this.activeId = undefined;
  }

  private recordSnapshot(flavor: Flavor, reason?: string): void {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const snap: FlavorSnapshot = {
      seq,
      capturedAt: this.now().toISOString(),
      flavor: deepClone(flavor),
      reason,
    };
    const list = this.snapshots.get(flavor.id) ?? [];
    list.unshift(snap);
    while (list.length > this.snapshotCap) list.pop();
    this.snapshots.set(flavor.id, list);
  }
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}
