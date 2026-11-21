/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type visibility for an adopted scene snapshot before its meshes decode (#10264).
 *
 * A snapshot holds every mesh, so its batches carry the spaces and openings
 * type visibility hides by id. Adoption draws them at once, while the mesh list
 * the viewport derives its type-hidden ids from is still empty. The snapshot
 * stores its type index (`TypeHiddenIndex.metadataOf`); adoption installs it
 * here, and the viewport hides those ids under the CURRENT settings until the
 * meshes are published. Adoption paints only after a viewport committed the
 * installed index (`acknowledgeSnapshotTypeIndex`), so the first frame already
 * hides them. A later install supersedes an earlier one, and each load clears
 * only its own.
 */

import { TypeHiddenIndex } from './type-hidden-index.js';

interface Installed {
  readonly token: object;
  readonly index: TypeHiddenIndex;
  settle(applied: boolean): void;
}

let installed: Installed | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeSnapshotTypeIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The installed index, or null outside an adoption window. */
export function snapshotTypeIndex(): TypeHiddenIndex | null {
  return installed?.index ?? null;
}

/**
 * Install `metadata` for the load `token`. Resolves true once a viewport has
 * committed it; false when the metadata is unusable, another load installed
 * its own, the token was cleared, or no viewport committed within `timeoutMs`.
 */
export function installSnapshotTypeIndex(token: object, metadata: unknown, timeoutMs = 2000): Promise<boolean> {
  const index = TypeHiddenIndex.fromMetadata(metadata);
  if (!index) return Promise.resolve(false);
  installed?.settle(false);
  return new Promise<boolean>((resolve) => {
    let open = true;
    const settle = (applied: boolean) => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      resolve(applied);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    installed = { token, index, settle };
    emit();
  });
}

/** A viewport committed a frame state hiding `index`'s ids. */
export function acknowledgeSnapshotTypeIndex(index: TypeHiddenIndex | null): void {
  if (index && installed?.index === index) installed.settle(true);
}

/** The load `token` published its meshes or ended: its index stops answering. Another load's is kept. */
export function clearSnapshotTypeIndex(token: object): void {
  if (installed?.token !== token) return;
  installed.settle(false);
  installed = null;
  emit();
}
