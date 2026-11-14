/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';

/** Transient viewport ownership; no create/SDK dependency on the startup path. */
export const useWallTopPick = create<{
  owner: string | null;
  accept: ((globalId: number | null) => void) | null;
}>(() => ({ owner: null, accept: null }));

export function consumeWallTopPick(globalId: number | null): boolean {
  const accept = useWallTopPick.getState().accept;
  if (!accept) return false;
  accept(globalId);
  return true;
}
export function cancelWallTopPick(): void {
  useWallTopPick.setState({ owner: null, accept: null });
}
