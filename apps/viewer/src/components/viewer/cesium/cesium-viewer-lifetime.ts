/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Synchronous ownership fence for work started by one Cesium Viewer.
 *
 * React effect cleanup is not synchronous with every continuation that was
 * started by sibling effects. Retiring this fence before `Viewer.destroy()`
 * gives those continuations one shared, immediate answer to "may I still
 * touch this scene?" (#4807).
 */
export class CesiumViewerLifetime {
  private retired = false;
  private readonly retireListeners = new Set<() => void>();

  constructor(readonly viewer: InstanceType<typeof import('cesium').Viewer>) {}

  /** True only while this exact viewer still owns its scene collections. */
  isLive(viewer: InstanceType<typeof import('cesium').Viewer>): boolean {
    return !this.retired && this.viewer === viewer;
  }

  isRetired(): boolean {
    return this.retired;
  }

  /** Register work that must stop before the viewer is destroyed. */
  onRetire(listener: () => void): () => void {
    if (this.retired) {
      listener();
      return () => {};
    }
    this.retireListeners.add(listener);
    return () => { this.retireListeners.delete(listener); };
  }

  /** Idempotent: a source switch and unmount can retire the same viewer. */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    for (const listener of this.retireListeners) listener();
    this.retireListeners.clear();
  }
}
