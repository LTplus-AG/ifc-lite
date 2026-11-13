/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react';

/** The active toolbar’s one file hook, never a second loader (#8947). */
export interface MountedFileHost {
  /** Component lifetime, independent of refreshed file callbacks. */
  readonly owner?: object;
  openFiles: () => void;
  addModel: () => void;
  refreshModels: () => Promise<void>;
  openShareDialog?: () => void;
  startBlank?: () => void;
}
let current: MountedFileHost | null = null;
const listeners = new Set<() => void>();
export const getMountedFileHost = () => current;
export function registerMountedFileHost(host: MountedFileHost): () => void {
  current = host;
  listeners.forEach(listener => listener());
  return () => {
    if (current !== host) return;
    current = null;
    listeners.forEach(listener => listener());
  };
}
export function useMountedFileHost(): MountedFileHost | null {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, getMountedFileHost, () => null);
}
