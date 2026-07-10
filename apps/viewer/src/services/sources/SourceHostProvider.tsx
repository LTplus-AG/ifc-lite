/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { SourceHost } from './source-host';
import { DaluxBuildProvider } from '@ifc-lite/source-dalux';

const SourceHostContext = createContext<SourceHost | null>(null);

export function useSourceHost(): SourceHost {
  const host = useContext(SourceHostContext);
  if (!host) throw new Error('useSourceHost must be used within <SourceHostProvider>');
  return host;
}

export function useOptionalSourceHost(): SourceHost | null {
  return useContext(SourceHostContext);
}

export function SourceHostProvider({ children }: { children: ReactNode }) {
  const host = useMemo(() => {
    const h = new SourceHost();
    h.register(new DaluxBuildProvider());
    return h;
  }, []);

  return (
    <SourceHostContext value={host}>
      {children}
    </SourceHostContext>
  );
}
