/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Registry change listeners: every listener sees each change, and the first failure is rethrown afterwards. */
export class RangeListeners {
  private listeners = new Set<(modelId?: string) => void>();

  add(listener: (modelId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  notify(modelId?: string): void {
    let failure: { error: unknown } | undefined;
    for (const listener of this.listeners) {
      try { listener(modelId); } catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
  }
}
