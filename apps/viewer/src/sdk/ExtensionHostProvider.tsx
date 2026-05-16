/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExtensionHostProvider` — React context for the viewer's extension
 * host service.
 *
 * Sits inside `<BimProvider>` so it can pull the live `BimContext`
 * out of the existing SDK plumbing. The service is constructed once
 * on mount, initialised lazily (we kick `init()` on the first commit
 * and surface the loaded statuses to listeners), and disposed on
 * unmount — though in practice the viewer lives for the whole tab
 * session so unmount is rare.
 *
 * Components consume the service via `useExtensionHost()` (everything
 * the user can do) or the specialised hooks
 * `useSlotContributions(slot)` and `useInstalledExtensions()`.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useBim } from './BimProvider.js';
import { ExtensionHostService } from '@/services/extensions/host.js';

const ExtensionHostContext = createContext<ExtensionHostService | null>(null);

interface ExtensionHostProviderProps {
  children: ReactNode;
}

export function ExtensionHostProvider({ children }: ExtensionHostProviderProps) {
  const bim = useBim();
  // Service identity must be stable across renders so subscribers don't
  // tear themselves down on every commit.
  const service = useMemo(() => new ExtensionHostService({ sdk: bim }), [bim]);

  const [, forceRender] = useState(0);
  useEffect(() => {
    void service.init();
    return service.onChange(() => forceRender((n) => n + 1));
  }, [service]);

  useEffect(() => {
    return () => {
      void service.dispose();
    };
  }, [service]);

  return (
    <ExtensionHostContext.Provider value={service}>
      {children}
    </ExtensionHostContext.Provider>
  );
}

/**
 * Access the extension host service. Throws if used outside
 * `<ExtensionHostProvider>`.
 */
export function useExtensionHost(): ExtensionHostService {
  const ctx = useContext(ExtensionHostContext);
  if (!ctx) {
    throw new Error('useExtensionHost() must be used within an <ExtensionHostProvider>');
  }
  return ctx;
}

/** Same as useExtensionHost but returns null instead of throwing. Useful for code paths that may or may not be inside the provider. */
export function useOptionalExtensionHost(): ExtensionHostService | null {
  return useContext(ExtensionHostContext);
}
