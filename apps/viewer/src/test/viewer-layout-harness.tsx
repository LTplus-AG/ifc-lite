/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renders the whole `ViewerLayout` for component tests.
 *
 * `ViewerLayout` always mounts `CommandPalette` (needs a `<BimProvider>`
 * ancestor for `useSandbox()`), `HierarchyPanel` (needs a
 * `<SourceHostProvider>`) and `FlavorDialog` (calls `useExtensionHost()`
 * unconditionally), whatever their own open state. Those three seams used to
 * be copied into each layout test; this is them, once. The desktop layout's
 * `FlavorIndicator` reads IndexedDB on mount, which happy-dom lacks.
 *
 * The narrow layout is its own lazily loaded chunk (#9718): a test of the
 * mobile shell awaits {@link mobileLayoutMounted} (or renders through
 * {@link renderMobileViewerLayout}) instead of assuming a synchronous render.
 */

import 'fake-indexeddb/auto';
import type { BimContext } from '@ifc-lite/sdk';
import { createBimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider.js';
import { ViewerLayout } from '@/components/viewer/ViewerLayout.js';
import { render, waitFor } from './render.js';

class StubExtensionHost extends ExtensionHostService {
  constructor() {
    super({
      sdk: createBimContext({
        transport: {
          send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
          subscribe: () => () => {},
          close: () => {},
        },
      }),
    });
  }
}

export function renderViewerLayout(): HTMLElement {
  return render(
    <BimReactContext.Provider value={{} as BimContext}>
      <ExtensionHostContext.Provider value={new StubExtensionHost()}>
        <SourceHostProvider>
          <ViewerLayout />
        </SourceHostProvider>
      </ExtensionHostContext.Provider>
    </BimReactContext.Provider>,
  );
}

/** Wait until the lazily loaded mobile layout (`MobileLayout`, #9718) has mounted. */
export async function mobileLayoutMounted(): Promise<void> {
  await waitFor(() => document.querySelector('[data-mobile-shell]') !== null, 'the lazily loaded mobile layout mounts');
}

/** {@link renderViewerLayout} in a narrow window, returned once its mobile layout has mounted. */
export async function renderMobileViewerLayout(): Promise<HTMLElement> {
  const container = renderViewerLayout();
  await mobileLayoutMounted();
  return container;
}
