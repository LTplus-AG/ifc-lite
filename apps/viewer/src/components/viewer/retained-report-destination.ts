/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react';

export const OPEN_RETAINED_REPORT = 'ifc-lite:open-retained-report';
const owners = new Set<symbol>();
const listeners = new Set<() => void>();
export function registerRetainedReportHost(): () => void {
  const owner = Symbol();
  owners.add(owner);
  for (const listener of listeners) listener();
  return () => { owners.delete(owner); for (const listener of listeners) listener(); };
}
export const hasRetainedReportHost = () => owners.size > 0;
export function useRetainedReportHost(): boolean {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, hasRetainedReportHost, () => false);
}
export function openRetainedReport(): void {
  window.dispatchEvent(new Event(OPEN_RETAINED_REPORT));
}
