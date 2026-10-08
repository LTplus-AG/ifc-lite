/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';

/**
 * The endpoint authority the user last exercised in the Linked records panel:
 * endpoint, hostname grant, optional loopback grant, relay and credential.
 * Session memory only. It is never persisted, never part of assistant
 * evidence or prompts, and any change of source in the panel revokes it.
 * This module stays free of the semantic package so the eager evidence
 * register can read whether a grant exists.
 */
export interface EndpointGrant {
  endpoint: string; host: string; loopbackHttpOrigin?: string; relayProvider?: string; bearer?: string; grantedAt: string;
}
export const useSemanticEndpointGrant = create<{ grant: EndpointGrant | null; generation: number }>(() => ({ grant: null, generation: 0 }));

export function recordEndpointGrant(grant: Omit<EndpointGrant, 'grantedAt'>): void {
  useSemanticEndpointGrant.setState(state => ({ grant: { ...grant, grantedAt: new Date().toISOString() }, generation: state.generation + 1 }));
}
export function revokeEndpointGrant(): void {
  if (useSemanticEndpointGrant.getState().grant) useSemanticEndpointGrant.setState(state => ({ grant: null, generation: state.generation + 1 }));
}
