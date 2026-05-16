/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Slot registry — host-side pub/sub for extension contributions.
 *
 * Extensions register one or more `SlotContribution`s under named slots
 * (e.g. `toolbar.right`, `commandPalette`). UI components subscribe to
 * slots and receive the current contribution list on every change.
 *
 * Spec: docs/architecture/ai-customization/03-ui-surface.md §2.
 *
 * Composition ordering is **not** the registry's responsibility. The
 * registry preserves registration order and emits the full list to
 * listeners; each slot's UI component applies the slot-specific sort
 * (e.g. `order` ascending, ties broken by id).
 */

import type { SlotContribution, SlotListener } from './types.js';

export class SlotRegistry {
  /** Map: slot id → contribution array, in registration order. */
  private contributions = new Map<string, SlotContribution[]>();

  /** Map: extension id → list of (slot, contribution) for fast unregister. */
  private byExtension = new Map<string, SlotContribution[]>();

  /** Map: slot id → set of listeners. */
  private listeners = new Map<string, Set<SlotListener>>();

  /**
   * Register one or more contributions. All contributions in the call
   * are applied atomically; listeners are notified once per affected
   * slot at the end.
   *
   * Throws if any contribution's `extensionId` mismatches the others.
   */
  register(extensionId: string, contributions: readonly SlotContribution[]): void {
    if (contributions.length === 0) return;

    for (const c of contributions) {
      if (c.extensionId !== extensionId) {
        throw new Error(
          `SlotRegistry: contribution extensionId "${c.extensionId}" does not match register() argument "${extensionId}".`,
        );
      }
    }

    const affectedSlots = new Set<string>();
    const extList = this.byExtension.get(extensionId) ?? [];

    for (const c of contributions) {
      let list = this.contributions.get(c.slot);
      if (!list) {
        list = [];
        this.contributions.set(c.slot, list);
      }
      list.push(c);
      extList.push(c);
      affectedSlots.add(c.slot);
    }
    this.byExtension.set(extensionId, extList);

    for (const slot of affectedSlots) this.notify(slot);
  }

  /**
   * Remove all contributions from an extension. Notifies listeners for
   * each affected slot. Safe to call for an unknown extension (no-op).
   */
  unregister(extensionId: string): void {
    const extList = this.byExtension.get(extensionId);
    if (!extList || extList.length === 0) {
      this.byExtension.delete(extensionId);
      return;
    }

    const affectedSlots = new Set<string>();
    for (const c of extList) affectedSlots.add(c.slot);

    for (const slot of affectedSlots) {
      const list = this.contributions.get(slot);
      if (!list) continue;
      const filtered = list.filter((c) => c.extensionId !== extensionId);
      if (filtered.length === 0) {
        this.contributions.delete(slot);
      } else {
        this.contributions.set(slot, filtered);
      }
    }

    this.byExtension.delete(extensionId);

    for (const slot of affectedSlots) this.notify(slot);
  }

  /** Get a snapshot of the contributions for a slot, in registration order. */
  getAll<T = unknown>(slot: string): SlotContribution<T>[] {
    const list = this.contributions.get(slot);
    return list ? ([...list] as SlotContribution<T>[]) : [];
  }

  /** All slots that currently have at least one contribution. */
  listSlots(): string[] {
    return Array.from(this.contributions.keys());
  }

  /**
   * Subscribe to a slot. The listener is invoked immediately with the
   * current contribution list and on every subsequent change.
   *
   * Returns an unsubscribe function.
   */
  subscribe<T = unknown>(slot: string, listener: SlotListener<T>): () => void {
    let set = this.listeners.get(slot);
    if (!set) {
      set = new Set();
      this.listeners.set(slot, set);
    }
    set.add(listener as SlotListener);

    // Initial emit.
    listener(this.getAll<T>(slot));

    return () => {
      const s = this.listeners.get(slot);
      if (!s) return;
      s.delete(listener as SlotListener);
      if (s.size === 0) this.listeners.delete(slot);
    };
  }

  /** True iff the extension has any registered contributions. */
  hasExtension(extensionId: string): boolean {
    const list = this.byExtension.get(extensionId);
    return !!list && list.length > 0;
  }

  /** Reset everything. Primarily for tests. */
  clear(): void {
    this.contributions.clear();
    this.byExtension.clear();
    // Notify listeners that everything is empty.
    for (const slot of this.listeners.keys()) this.notify(slot);
  }

  private notify(slot: string): void {
    const set = this.listeners.get(slot);
    if (!set) return;
    const snapshot = this.getAll(slot);
    for (const listener of set) listener(snapshot);
  }
}
