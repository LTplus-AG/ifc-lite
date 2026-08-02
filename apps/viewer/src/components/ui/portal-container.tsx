/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Portal-container context (#1208).
 *
 * Radix overlays (dropdown menu, select, tooltip, dialog) portal to the
 * document body by default. When a workspace panel is popped out into a
 * separate OS / PiP window (#1208), its menus must portal into THAT window's
 * document instead of the original tab — otherwise a Script panel's dropdowns
 * and dialogs render in the main window (behind it / off-screen).
 *
 * `PanelWindowChrome` wraps the popped-out panel in a provider pointing at the
 * child window's `document.body`; the shared UI primitives read this and pass
 * it to their Radix `*.Portal container` prop. The default is `undefined`, so
 * normal (main-window) usage is unchanged.
 */

import * as React from 'react';

const PortalContainerContext = React.createContext<HTMLElement | null>(null);

export function PortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: React.ReactNode;
}) {
  return <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>;
}

/** The Radix portal container for the current subtree, or `undefined` to use
 *  the default document body. */
export function usePortalContainer(): HTMLElement | undefined {
  return React.useContext(PortalContainerContext) ?? undefined;
}
