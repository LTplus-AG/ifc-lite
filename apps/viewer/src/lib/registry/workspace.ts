/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { localRegistryAddress } from './connection';
import type { RegistryRelease } from './artifacts';
import { RegistryTransport, type RegistrySession } from './transport';

interface RegistryWorkspace {
  address: string;
  models: string[];
  modelTitles: Record<string, string>;
  catalogNext?: string;
  releases: RegistryRelease[];
  transport: RegistryTransport | null;
  session: RegistrySession | null;
  repository: string;
  release: string;
  version: string;
  tags: string[];
  fingerprint: string;
  published: string;
}

const initial: RegistryWorkspace = {
  address: localRegistryAddress, catalogNext: undefined, models: [], modelTitles: {}, releases: [], transport: null, session: null, repository: '', release: '',
  version: 'revision-2', tags: [], fingerprint: '', published: '',
};

/** Tab memory only: closing Cloud Sources must not sign out before editing. */
export const useRegistryWorkspace = create<RegistryWorkspace>(() => initial);
export const updateRegistryWorkspace = useRegistryWorkspace.setState;

export function registryTransport(origin: string): RegistryTransport {
  const current = useRegistryWorkspace.getState().transport;
  if (current?.origin === origin) return current;
  current?.logout();
  const transport = new RegistryTransport(origin);
  updateRegistryWorkspace({ ...initial, transport });
  return transport;
}

export function clearRegistrySession(): void {
  const { transport, address } = useRegistryWorkspace.getState();
  transport?.logout();
  updateRegistryWorkspace({ ...initial, transport, address });
}
