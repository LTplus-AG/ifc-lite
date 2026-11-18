/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer, PickOptions } from '@ifc-lite/renderer';
export interface AgentViewportHost {
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  getPickOptions(): PickOptions;
}
let mounted: AgentViewportHost | undefined;
/** Same mounted renderer and effective visibility options used by native clicks. */
export function registerAgentViewportHost(host: AgentViewportHost): () => void {
  mounted = host;
  return () => { if (mounted === host) mounted = undefined; };
}
export function getAgentViewportHost(): AgentViewportHost | undefined { return mounted; }
