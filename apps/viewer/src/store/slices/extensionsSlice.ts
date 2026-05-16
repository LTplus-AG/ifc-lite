/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Extensions panel visibility slice.
 *
 * The extension system's actual state lives in the host service
 * (services/extensions/host.ts) — installed bundles, audit log, slot
 * contributions. The store only owns the UI-toggle state so panel
 * visibility behaves like every other dock panel (IDS, BCF, Lens,
 * Lists, Script).
 */

import type { StateCreator } from 'zustand';

export interface ExtensionsSlice {
  extensionsPanelVisible: boolean;
  setExtensionsPanelVisible: (visible: boolean) => void;
  toggleExtensionsPanel: () => void;
}

export const createExtensionsSlice: StateCreator<
  ExtensionsSlice,
  [],
  [],
  ExtensionsSlice
> = (set) => ({
  extensionsPanelVisible: false,
  setExtensionsPanelVisible: (extensionsPanelVisible) => set({ extensionsPanelVisible }),
  toggleExtensionsPanel: () =>
    set((state) => ({ extensionsPanelVisible: !state.extensionsPanelVisible })),
});
