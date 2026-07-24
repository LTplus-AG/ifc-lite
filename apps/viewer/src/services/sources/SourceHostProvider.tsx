/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { SourceHost } from './source-host';
import { createRegisteredProviders } from './registered-providers';

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
 * Builds the `SourceHost` used by the whole app, registering every provider
 * from `createRegisteredProviders()`. This runs inside a top-level
 * `useMemo` wrapping the entire app, so nothing here may throw: a provider
 * whose manifest has drifted out of date, or whose constructor itself
 * misbehaves, must degrade to "this one provider is unavailable" rather than
 * white-screen the viewer. `SourceHost.register` already never throws (see
 * `source-host.ts`); the `try`/`catch` around provider *construction* here is
 * defense in depth for a provider that throws before `register` ever sees it.
 * Either way, the failure ends up in `host.getRegistrationFailures()` so a
 * settings panel can show "provider X failed to load: reason" instead of the
 * provider just silently not being there.
 */
function buildSourceHost(): SourceHost {
  const host = new SourceHost();

  let providers: ReturnType<typeof createRegisteredProviders>;
  try {
    providers = createRegisteredProviders();
  } catch (error) {
    console.error('[source-host] Failed to construct registered providers', error);
    return host;
  }

  for (const provider of providers) {
    let name = '(unknown provider)';
    try {
      name = provider.manifest.name;
      host.register(provider);
    } catch (error) {
      // register() itself is designed not to throw, but a provider's own
      // `manifest` getter could still misbehave before register() ever runs.
      console.error(`[source-host] Unexpected error registering "${name}"`, error);
    }
  }

  return host;
}

export function SourceHostProvider({ children }: { children: ReactNode }) {
  const host = useMemo(buildSourceHost, []);

  return (
    <SourceHostContext value={host}>
      {children}
    </SourceHostContext>
  );
}
