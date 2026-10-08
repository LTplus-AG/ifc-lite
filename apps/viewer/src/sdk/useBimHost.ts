/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useBimHost — React hook that initializes the SDK and BimHost.
 *
 * This hook:
 * 1. Creates a LocalBackend backed by the Zustand store
 * 2. Creates a BimContext (the `bim` object)
 * 3. Starts a BimHost listening on BroadcastChannel 'ifc-lite'
 * 4. External tools (ifc-scripts, ifc-flow) can connect to control the viewer
 *
 * Usage:
 *   function App() {
 *     const bim = useBimHost();
 *     // bim is available for internal use
 *     // External tools can connect via BroadcastChannel 'ifc-lite'
 *   }
 */

import { useRef, useEffect, useMemo } from 'react';
import { createBimContext, BimHost, type BimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '../store/index.js';
import { LocalBackend } from './local-backend.js';

const BROADCAST_CHANNEL = 'ifc-lite';

/**
 * Initialize the SDK with a local backend and start the BimHost.
 * Returns the BimContext for internal use.
 */
export function useBimHost(): BimContext {
  const hostRef = useRef<BimHost | null>(null);
  const backendRef = useRef<LocalBackend | null>(null);

  // Create local backend and BimContext once — single shared backend
  const bim = useMemo(() => {
    const backend = new LocalBackend(useViewerStore);
    backendRef.current = backend;
    return createBimContext({ backend });
  }, []);

  // Start BimHost for external connections — reuse the same backend
  useEffect(() => {
    const backend = backendRef.current;
    if (!backend) return;
    const host = new BimHost(backend);

    try {
      host.listenBroadcast(BROADCAST_CHANNEL);
    } catch (error) {
      console.warn('[useBimHost] Could not start the BroadcastChannel host', error);
    }

    hostRef.current = host;

    return () => {
      host.close();
      hostRef.current = null;
    };
  }, []);

  return bim;
}
