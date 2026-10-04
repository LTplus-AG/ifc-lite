/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentKind } from './content-database.js';

let channel: BroadcastChannel | null = null;
const listeners = new Set<(kind: ContentKind) => void>();
function contentChannel(): BroadcastChannel | null {
  if (!channel && typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function') {
    channel = new window.BroadcastChannel('ifc-lite-user-content');
    // Node's DOM harness supplies a channel that otherwise keeps test workers alive.
    (channel as BroadcastChannel & { unref?: () => void }).unref?.();
    channel.onmessage = event => {
      if (event.data === 'document' || event.data === 'validation' || event.data === 'comparison' || event.data === 'assistant') {
        for (const listener of listeners) listener(event.data);
      }
    };
  }
  return channel;
}
export function announceContentChange(kind: ContentKind): void {
  try { contentChannel()?.postMessage(kind); }
  catch (error) { console.warn('[User content] Change notification unavailable; refresh on focus', error); }
}
export function subscribeContentChanges(listener: (kind: ContentKind) => void): () => void {
  listeners.add(listener);
  try { contentChannel(); }
  catch (error) { console.warn('[User content] Notifications unavailable; refresh on focus', error); }
  return () => listeners.delete(listener);
}
