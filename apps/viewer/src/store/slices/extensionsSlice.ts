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

export type ExtensionsTabView = 'installed' | 'ideas' | 'audit' | 'repair' | 'privacy';

export interface ExtensionsSlice {
  extensionsPanelVisible: boolean;
  setExtensionsPanelVisible: (visible: boolean) => void;
  toggleExtensionsPanel: () => void;
  /**
   * Bytes of an authored bundle waiting for the user to review. The
   * chat-side authoring loop sets this on success; the Extensions
   * panel picks it up on mount, routes through CapabilityReview, and
   * clears the slot after install or cancel.
   */
  pendingAuthoredBundle: Uint8Array | null;
  setPendingAuthoredBundle: (bytes: Uint8Array | null) => void;
  /**
   * Which tab the Extensions panel should show. Set by deep-link
   * entry points (Command Palette "Author an extension…", chat
   * routing after a successful authoring loop) so the panel mounts
   * straight into the right surface.
   */
  extensionsRequestedView: ExtensionsTabView | null;
  setExtensionsRequestedView: (view: ExtensionsTabView | null) => void;
  /**
   * When true, the IdeasPanel should open the Plan Card in
   * empty-plan mode on mount. Consumed once then cleared.
   */
  ideasOpenEmptyPlan: boolean;
  setIdeasOpenEmptyPlan: (open: boolean) => void;
  /**
   * When true, the FlavorDialog should auto-open. Consumed once
   * then cleared by the dialog wrapper.
   */
  flavorDialogRequested: boolean;
  setFlavorDialogRequested: (open: boolean) => void;
  /**
   * Post-authoring "install" handoff. After the chat finishes an
   * authoring turn, it sets this so the chat panel can render a
   * prominent inline CTA — the user no longer has to hunt for a
   * Promote button in another panel.
   *
   *   kind 'bundle' — a full `.iflx` bundle was synthesised and is
   *                   waiting in `pendingAuthoredBundle`; the CTA
   *                   routes to the Extensions panel review.
   *   kind 'script' — the assistant wrote a one-shot script into the
   *                   editor; the CTA opens PromoteToolDialog.
   *
   * Cleared when the user acts on it, dismisses it, or starts a new
   * chat.
   */
  chatToolReady: { kind: 'bundle' | 'script'; name: string } | null;
  setChatToolReady: (v: { kind: 'bundle' | 'script'; name: string } | null) => void;
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
  pendingAuthoredBundle: null,
  setPendingAuthoredBundle: (pendingAuthoredBundle) => set({ pendingAuthoredBundle }),
  extensionsRequestedView: null,
  setExtensionsRequestedView: (extensionsRequestedView) => set({ extensionsRequestedView }),
  ideasOpenEmptyPlan: false,
  setIdeasOpenEmptyPlan: (ideasOpenEmptyPlan) => set({ ideasOpenEmptyPlan }),
  flavorDialogRequested: false,
  setFlavorDialogRequested: (flavorDialogRequested) => set({ flavorDialogRequested }),
  chatToolReady: null,
  setChatToolReady: (chatToolReady) => set({ chatToolReady }),
});
