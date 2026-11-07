/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ExtensionHostService } from '@/services/extensions/host';

// Every export surface shares the same host execution lock. Weak ownership
// releases retired providers without keeping the service alive indefinitely.
const states = new WeakMap<ExtensionHostService, { key: string | null; listeners: Set<() => void> }>();
function state(host: ExtensionHostService) {
  let value = states.get(host);
  if (!value) { value = { key: null, listeners: new Set() }; states.set(host, value); }
  return value;
}
export function runningExtensionExport(host: ExtensionHostService | null): string | null {
  return host ? state(host).key : null;
}
export function subscribeExtensionExport(host: ExtensionHostService | null, listener: () => void) {
  if (!host) return () => {};
  const value = state(host); value.listeners.add(listener);
  return () => { value.listeners.delete(listener); };
}
export function setRunningExtensionExport(host: ExtensionHostService, key: string | null) {
  const value = state(host); value.key = key;
  for (const listener of value.listeners) listener();
}
