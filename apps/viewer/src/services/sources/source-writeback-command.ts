/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const SOURCE_WRITEBACK_EVENT = 'ifc-lite:save-to-source';
export function openSourceWriteBack(modelId: string): void {
  window.dispatchEvent(new CustomEvent<string>(SOURCE_WRITEBACK_EVENT, { detail: modelId }));
}
/** Subscribes to Save to source requests; returns the unsubscribe. */
export function onOpenSourceWriteBack(handler: (modelId: string) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<string>).detail);
  window.addEventListener(SOURCE_WRITEBACK_EVENT, listener);
  return () => window.removeEventListener(SOURCE_WRITEBACK_EVENT, listener);
}
