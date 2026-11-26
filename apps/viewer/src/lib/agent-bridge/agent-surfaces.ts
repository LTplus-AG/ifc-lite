/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AGENT_SURFACE_PANELS, type BridgeSurfaceMessage } from '@ifc-lite/mcp/bridge-protocol';

export type AgentSurface = BridgeSurfaceMessage['surface'];
/** Shared with the bridge, which keeps these panels' surface ids so their clicks are admitted. */
const MAX_SURFACES = AGENT_SURFACE_PANELS;
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
  dismiss(surface: AgentSurface): void {
    if (surfaces.includes(surface)) publish(surfaces.filter((s) => s !== surface));
  },
  clear(): void {
    if (surfaces.length) publish([]);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
