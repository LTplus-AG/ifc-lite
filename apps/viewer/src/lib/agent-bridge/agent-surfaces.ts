/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BridgeSurfaceMessage } from '@ifc-lite/mcp/bridge-protocol';

export type AgentSurface = BridgeSurfaceMessage['surface'];
const MAX_SURFACES = 16;
let surfaces: readonly AgentSurface[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly AgentSurface[]): void {
  surfaces = next;
  for (const listener of listeners) listener();
}

export const agentSurfaces = {
  getSnapshot: (): readonly AgentSurface[] => surfaces,
  push(surface: AgentSurface): void {
    publish([...surfaces.slice(1 - MAX_SURFACES), surface]);
  },
  clear(): void {
    if (surfaces.length) publish([]);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
