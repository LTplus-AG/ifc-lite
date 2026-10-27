/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { RegistryTransport, type RegistrySession } from './transport';

interface RegistryWorkspace {
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
  transport: null, session: null, repository: 'project/model', release: 'issued',
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
  const { transport } = useRegistryWorkspace.getState();
  transport?.logout();
  updateRegistryWorkspace({ ...initial, transport });
}
