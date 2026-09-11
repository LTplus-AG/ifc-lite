/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView } from './mutable-property-view.js';
import type { MutableOverlayState } from './mutable-overlay-state.js';

export type OverlaySnapshot = ReturnType<MutableOverlayState['copyOverlayState']>;
interface OverlayAccess {
  capture(): OverlaySnapshot;
  matches(snapshot: OverlaySnapshot): boolean;
  draft(snapshot: OverlaySnapshot): MutablePropertyView;
  publish(snapshot: OverlaySnapshot): void;
}
const access = new WeakMap<MutablePropertyView, OverlayAccess>();
/** Package-private capability; no mutable graph is exposed by the public handle. */
export function registerCooperativeOverlay(view: MutablePropertyView, capabilities: OverlayAccess): void {
  access.set(view, capabilities);
}
export function cooperativeOverlay(view: MutablePropertyView): OverlayAccess {
  const result = access.get(view);
  if (!result) throw new Error('Unregistered mutation view.');
  return result;
}
