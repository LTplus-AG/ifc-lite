/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "This model's load has ended": the loader has run that model's load to its
 * end (finalize, publication, and the settle of the load UI, `settleLoadUi`).
 * Marked once per load by `settleOwnedLoadUi` for a cold load, a cache hit, a
 * federated add and each file of a multi-file open. The load window
 * (`loadWindow.ts`) releases a model only after this mark; the model's record
 * turning `complete` (finalize publication) is earlier than this on a cache hit.
 */

type Listener = (modelId: string) => void;
const listeners = new Set<Listener>();

export function markModelLoadEnded(modelId: string): void {
  for (const listener of [...listeners]) listener(modelId);
}

export function subscribeModelLoadEnded(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
