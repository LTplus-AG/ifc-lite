/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import { SOURCE_WRITEBACK_EVENT } from './source-writeback-command';
import { SourceHost, type FileSourceProviderFactory } from './source-host';
import { BUILT_IN_PROVIDER_FACTORIES } from './registered-providers';

const SourceWriteBackDialog = lazy(() => import('@/components/sources/SourceWriteBackDialog').then(module => ({ default: module.SourceWriteBackDialog })));

const SourceHostContext = createContext<SourceHost | null>(null);

export function useSourceHost(): SourceHost {
  const host = useContext(SourceHostContext);
  if (!host) throw new Error('useSourceHost must be used within <SourceHostProvider>');
  return host;
}

export function useOptionalSourceHost(): SourceHost | null {
  return useContext(SourceHostContext);
}

/**
 * Builds the `SourceHost` used by the whole app: the built-in providers from
 * `registered-providers.ts` first, then any `additionalProviders` a host
 * application supplied at bootstrap (#5228). This runs once, while the app
 * tree mounts, so nothing here may throw: a provider whose manifest has
 * drifted out of date, or whose constructor itself misbehaves, must degrade
 * to "this one provider is unavailable" rather than white-screen the viewer.
 * Each factory is constructed and registered on its own through
 * `SourceHost.registerFactory`, so a throwing one cannot stop the built-ins or
 * any later provider from registering, and its failure ends up in
 * `host.getRegistrationFailures()` so the sources panel shows "provider X
 * failed to register: reason" instead of the provider silently not being
 * there. Built-ins go first, so a host-supplied provider reusing a built-in's
 * name is the one refused as a duplicate.
 */
function buildSourceHost(
  additionalProviders: readonly FileSourceProviderFactory[] = [],
): SourceHost {
  const host = new SourceHost();
  BUILT_IN_PROVIDER_FACTORIES.forEach((factory, index) => {
    host.registerFactory(factory, `built-in provider #${index + 1}`);
  });
  additionalProviders.forEach((factory, index) => {
    host.registerFactory(factory, `host-supplied provider #${index + 1}`);
  });
  return host;
}

export interface SourceHostProviderProps {
  children: ReactNode;
  /**
   * Extra provider factories a host application registers alongside the
   * built-ins; see `ViewerBootstrapOptions.sourceProviders` in `bootstrap.tsx`.
   */
  additionalProviders?: readonly FileSourceProviderFactory[];
}

export function SourceHostProvider({ children, additionalProviders }: SourceHostProviderProps) {
  // Bootstrap-time composition: the provider set is fixed for the app's
  // lifetime, so a later change to `additionalProviders` is deliberately not
  // re-read (it would construct every provider again and drop their state).
  const [host] = useState(() => buildSourceHost(additionalProviders));

  const [saveModelId, setSaveModelId] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') setSaveModelId(previous => previous ?? event.detail);
    };
    window.addEventListener(SOURCE_WRITEBACK_EVENT, open);
    return () => window.removeEventListener(SOURCE_WRITEBACK_EVENT, open);
  }, []);

  return (
    <SourceHostContext value={host}>
      {children}
      {saveModelId && <Suspense fallback={null}><SourceWriteBackDialog key={saveModelId} modelId={saveModelId} onClose={() => setSaveModelId(null)} /></Suspense>}
    </SourceHostContext>
  );
}
