/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pop-out workspace-panel windows (#1208).
 *
 * Tears a panel off into a separate OS window the user can drag onto another
 * screen or keep as a detached tab. Prefers the **Document Picture-in-Picture**
 * API (Chrome / Edge — borderless, always-on-top, ideal for a second monitor)
 * and falls back to **`window.open`** everywhere else.
 *
 * The panel is NOT re-implemented in the child window: {@link PanelWindowHost}
 * `createPortal`s the same component into the child document, so it keeps
 * running in *this* tab's React tree and reads/writes the *same* Zustand store
 * — state stays live across windows with zero sync code. We only have to copy
 * the stylesheets + theme class into the child document.
 *
 * This module is a framework-agnostic singleton (mirrors `analysis-extensions`)
 * so the pop-out action can run synchronously inside the click handler — which
 * the PiP / `window.open` user-activation requirement demands — while the host
 * subscribes via `useSyncExternalStore` and owns the portals.
 */

import { getViewerStoreApi } from '@/store';
import { getPanelDef, type WorkspacePanelId } from '@/lib/panels/registry';

interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}
declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }
}

export type PanelWindowKind = 'pip' | 'popup';

export interface PanelWindowEntry {
  id: WorkspacePanelId;
  win: Window;
  kind: PanelWindowKind;
}

const open = new Map<WorkspacePanelId, PanelWindowEntry>();
const listeners = new Set<() => void>();
let snapshot: PanelWindowEntry[] = [];

function rebuildSnapshot(): void {
  snapshot = [...open.values()];
}
function emit(): void {
  rebuildSnapshot();
  for (const l of listeners) l();
}

export function subscribePanelWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getPanelWindowsSnapshot(): PanelWindowEntry[] {
  return snapshot;
}

/** Copy the app's stylesheets + theme class into a popped-out document so the
 *  portalled panel looks identical (Tailwind v4 emits one stylesheet; theme
 *  vars live on `:root` / `.dark` / `.colorful`). */
function bridgeStyles(target: Document): void {
  const head = target.head ?? target.documentElement.appendChild(target.createElement('head'));
  // Clone every author stylesheet (dev: <style>, prod: <link>); cover the whole
  // document, not just <head>, in case a lib injected styles into the body.
  document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    head.appendChild(node.cloneNode(true));
  });
  // Mirror theme classes (dark / colorful) + language onto the child root.
  target.documentElement.className = document.documentElement.className;
  target.documentElement.lang = document.documentElement.lang || 'en';
  // Make the body fill the window with the app background.
  target.documentElement.style.height = '100%';
  target.body.style.margin = '0';
  target.body.style.height = '100%';
  target.body.style.background = 'var(--background, #fff)';
}

function defaultSize(id: WorkspacePanelId): { width: number; height: number } {
  return getPanelDef(id)?.prefersWide ? { width: 780, height: 680 } : { width: 440, height: 640 };
}

/**
 * `poppedOutIds` in the store is the source of truth for which panels are torn
 * off. Anyone can re-dock a panel by removing its id (showWorkspacePanel,
 * toggleWorkspacePanel, the toolbar) — when that happens we close the matching
 * OS window so the two never disagree. Set up lazily on the first pop-out so
 * tests / headless envs that never pop out don't touch the store.
 */
let storeUnsub: (() => void) | null = null;
function ensureStoreReconcile(): void {
  if (storeUnsub) return;
  try {
    const api = getViewerStoreApi();
    storeUnsub = api.subscribe((state) => {
      if (open.size === 0) return;
      const popped = new Set(state.poppedOutIds);
      for (const id of [...open.keys()]) {
        if (!popped.has(id)) detach(id, true);
      }
    });
  } catch {
    /* store not ready (tests) */
  }
}

function detach(id: WorkspacePanelId, closeWindow: boolean): void {
  const entry = open.get(id);
  if (!entry) return;
  open.delete(id);
  try {
    if (closeWindow && !entry.win.closed) entry.win.close();
  } catch {
    /* cross-window close can throw if already gone */
  }
  try {
    getViewerStoreApi().getState().setPanelPoppedOut(id, false);
  } catch {
    /* store not ready (tests) */
  }
  emit();
}

/**
 * Tear `id` off into a PiP / popup window. Returns the window kind, or null if
 * the browser blocked it. Safe to call from a click handler (consumes the
 * user activation synchronously before the first await).
 */
export async function openPanelWindow(id: WorkspacePanelId): Promise<PanelWindowKind | null> {
  if (typeof window === 'undefined') return null;
  ensureStoreReconcile();
  const existing = open.get(id);
  if (existing) {
    try { existing.win.focus(); } catch { /* noop */ }
    return existing.kind;
  }

  const { width, height } = defaultSize(id);
  const def = getPanelDef(id);
  let win: Window | null = null;
  let kind: PanelWindowKind = 'popup';

  const pip = window.documentPictureInPicture;
  const pipPromise = pip ? pip.requestWindow({ width, height }) : null;
  if (pipPromise) {
    try {
      win = await pipPromise;
      kind = 'pip';
    } catch {
      win = null; // user dismissed or PiP unavailable — fall through to popup
    }
  }
  if (!win) {
    const features = `popup,width=${width},height=${height},left=${Math.max(0, (window.screen?.availWidth ?? width) - width - 40)},top=120`;
    win = window.open('', `ifc-lite-panel-${id}`, features);
    kind = 'popup';
  }
  if (!win) return null; // blocked by a popup blocker

  try {
    win.document.title = `${def?.title ?? id} — ifc-lite`;
    bridgeStyles(win.document);
  } catch {
    /* about:blank not ready in some engines — portal still mounts into body */
  }

  // A panel lives in exactly one place: leave the docked slot / float behind.
  try {
    const s = getViewerStoreApi().getState();
    s.closeFloatingPanel(id);
    s.setPanelPoppedOut(id, true);
  } catch {
    /* store not ready */
  }

  const entry: PanelWindowEntry = { id, win, kind };
  open.set(id, entry);

  // Closing the child (its own X, or the user closing the window) re-docks.
  const onClosed = () => detach(id, false);
  win.addEventListener('pagehide', onClosed, { once: true });
  win.addEventListener('unload', onClosed, { once: true });

  emit();
  return kind;
}

/** Close a popped-out panel (re-dockable from the activity bar afterwards). */
export function closePanelWindow(id: WorkspacePanelId): void {
  detach(id, true);
}

/** Close every popped-out window — call on the parent tab unloading. */
export function closeAllPanelWindows(): void {
  for (const id of [...open.keys()]) detach(id, true);
}

/** Push the current theme class onto every open window (parent theme changed). */
export function syncPanelWindowsTheme(className: string): void {
  for (const { win } of open.values()) {
    try {
      if (!win.closed) win.document.documentElement.className = className;
    } catch {
      /* noop */
    }
  }
}
