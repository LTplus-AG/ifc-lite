/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { sanitizeSource } from '@ifc-lite/semantic';

/**
 * The endpoint authority the user last exercised in the Linked records panel:
 * endpoint, hostname grant, optional loopback grant, relay and credential.
 * Session memory only. It is never persisted, never part of assistant
 * evidence or prompts, and any change of source in the panel revokes it.
 */
export interface EndpointGrant {
  endpoint: string; host: string; loopbackHttpOrigin?: string; relayProvider?: string; bearer?: string; grantedAt: string;
}
export const useSemanticEndpointGrant = create<{ grant: EndpointGrant | null }>(() => ({ grant: null }));

export function recordEndpointGrant(grant: Omit<EndpointGrant, 'grantedAt'>): void {
  useSemanticEndpointGrant.setState({ grant: { ...grant, grantedAt: new Date().toISOString() } });
}
export function revokeEndpointGrant(): void {
  if (useSemanticEndpointGrant.getState().grant) useSemanticEndpointGrant.setState({ grant: null });
}

/** What a reviewer may see: where the query goes and which grants apply, never the credential value. */
export interface GrantDisclosure { endpoint: string; host: string; loopback: boolean; relay: string | null; credential: boolean }
export function discloseGrant(grant: EndpointGrant): GrantDisclosure {
  return { endpoint: sanitizeSource(grant.endpoint), host: grant.host, loopback: !!grant.loopbackHttpOrigin,
    relay: grant.relayProvider ?? null, credential: !!grant.bearer };
}
