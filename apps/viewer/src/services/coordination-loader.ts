/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FederationAddModelOptions } from '@/hooks/modelLoadOptions';
export type NativeModelAdder = (file: File, options?: FederationAddModelOptions) => Promise<string | null>;
const loaders = new Map<symbol, NativeModelAdder>();
/** Native addModel retains memory admission and RTC alignment, then calls the canonical loadFile. */
export function attachCoordinationModelAdder(load: NativeModelAdder): () => void {
  const owner = Symbol(); loaders.set(owner, load); return () => { loaders.delete(owner); };
}
export function coordinationModelAdder(): NativeModelAdder {
  const current = [...loaders.values()].at(-1); if (!current) throw new Error('The viewer federation loader is not mounted.'); return current;
}
