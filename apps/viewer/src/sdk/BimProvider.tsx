/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BimProvider — React context for the SDK's BimContext.
 *
 * Wraps useBimHost() and makes the `bim` object available to all children
 * via useBim(). This enables gradual migration: components can progressively
 * switch from direct Zustand store calls to SDK calls.
 *
 * Usage:
 *   <BimProvider>
 *     <App />
 *   </BimProvider>
 *
 *   // In any component:
 *   const bim = useBim();
 *   const walls = bim.query().byType('IfcWall').toArray();
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { useBimHost } from './useBimHost.js';

/**
 * Exported as a rendering-test seam, same rationale as
 * `ExtensionHostContext`: tests supply a stub `BimContext` through this
 * context instead of `mock.module`, which is flag-gated
 * (`--experimental-test-module-mocks`) on Node 22. `apps/viewer` is a
 * private, unpublished app, so exporting this widens no public API.
 */
export const BimReactContext = createContext<BimContext | null>(null);

/** Provider that initializes the SDK and makes it available via useBim() */
export function BimProvider({ children }: { children: ReactNode }) {
  const bim = useBimHost();
  return (
    <BimReactContext.Provider value={bim}>
      {children}
    </BimReactContext.Provider>
  );
}

/**
 * Access the BimContext from any component.
 * Must be rendered inside a <BimProvider>.
 *
 * @throws if used outside a BimProvider
 */
export function useBim(): BimContext {
  const ctx = useContext(BimReactContext);
  if (!ctx) {
    throw new Error('useBim() must be used within a <BimProvider>');
  }
  return ctx;
}
