/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Coalesce a source batch's topology notifications instead of notifying once
 * per mesh. No frame loop or idle polling is needed for inspector metadata. */
export class GeometryChangeSignal {
  private listeners = new Set<() => void>();
  private pending = false;
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  changed(): void {
    if (this.pending || this.listeners.size === 0) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      for (const listener of this.listeners) {
        try { listener(); } catch (error) { console.error('[Scene] geometry listener failed:', error); }
      }
    });
  }
}
