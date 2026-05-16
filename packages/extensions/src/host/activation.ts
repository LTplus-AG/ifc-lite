/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Activation event dispatcher.
 *
 * Tracks which extensions have registered which activation events and
 * dispatches a `fire(event)` call to activate them on demand. The
 * dispatcher does not own activation logic — it calls a user-supplied
 * `onActivate` handler that the host (loader) uses to instantiate the
 * extension's sandbox and call its `entry.activate(ctx)`.
 *
 * Activation is **at-most-once-per-event**: an extension that has already
 * been activated stays active until it is explicitly unregistered.
 * Subsequent fires of an activation event the extension is registered
 * for are no-ops as far as the dispatcher is concerned (events are still
 * delivered to listeners; activation just doesn't repeat).
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §3.
 */

import type { ActivationEvent } from '../types.js';

export type ActivationListener = (
  extensionId: string,
  event: ActivationEvent,
) => Promise<void> | void;

interface ExtensionEntry {
  events: Set<ActivationEvent>;
  /** Has the extension been activated at least once in this session? */
  activated: boolean;
}

export class ActivationDispatcher {
  private byExtension = new Map<string, ExtensionEntry>();
  private byEvent = new Map<ActivationEvent, Set<string>>();
  private listeners = new Set<ActivationListener>();

  /**
   * Register an extension with its activation events. Replaces any
   * previous registration for the same id.
   */
  register(extensionId: string, events: readonly ActivationEvent[]): void {
    this.unregister(extensionId);
    if (events.length === 0) return;
    const entry: ExtensionEntry = { events: new Set(events), activated: false };
    this.byExtension.set(extensionId, entry);
    for (const event of events) {
      let set = this.byEvent.get(event);
      if (!set) {
        set = new Set();
        this.byEvent.set(event, set);
      }
      set.add(extensionId);
    }
  }

  unregister(extensionId: string): void {
    const entry = this.byExtension.get(extensionId);
    if (!entry) return;
    for (const event of entry.events) {
      const set = this.byEvent.get(event);
      if (!set) continue;
      set.delete(extensionId);
      if (set.size === 0) this.byEvent.delete(event);
    }
    this.byExtension.delete(extensionId);
  }

  /**
   * Subscribe a listener that runs when an extension should be
   * activated. Listeners are invoked sequentially per extension so the
   * caller can rely on awaiting completion before the next listener
   * runs. Returns an unsubscribe function.
   */
  onActivate(listener: ActivationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Fire an activation event. Returns the list of extension ids that
   * were activated by this fire (in deterministic order). Re-firing the
   * same event activates only the not-yet-activated extensions tied to
   * it.
   */
  async fire(event: ActivationEvent): Promise<string[]> {
    const subscribed = this.byEvent.get(event);
    if (!subscribed || subscribed.size === 0) return [];

    const activatedNow: string[] = [];
    const ids = Array.from(subscribed).sort();
    for (const id of ids) {
      const entry = this.byExtension.get(id);
      if (!entry || entry.activated) continue;
      entry.activated = true;
      activatedNow.push(id);
      for (const listener of this.listeners) {
        await listener(id, event);
      }
    }
    return activatedNow;
  }

  /** Reset the "already activated" flag — used by tests and on flavor switch. */
  resetActivation(extensionId?: string): void {
    if (extensionId === undefined) {
      for (const entry of this.byExtension.values()) entry.activated = false;
      return;
    }
    const entry = this.byExtension.get(extensionId);
    if (entry) entry.activated = false;
  }

  /** True iff the extension has been activated this session. */
  isActivated(extensionId: string): boolean {
    return this.byExtension.get(extensionId)?.activated ?? false;
  }

  /** All currently-registered extension ids. */
  listExtensions(): string[] {
    return Array.from(this.byExtension.keys());
  }

  /** All activation events at least one extension is registered for. */
  listEvents(): ActivationEvent[] {
    return Array.from(this.byEvent.keys());
  }
}
