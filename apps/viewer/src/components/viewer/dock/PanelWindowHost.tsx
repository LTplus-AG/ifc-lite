/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renders the panels that have been popped out into OS / PiP windows (#1208).
 *
 * Each open window gets a `createPortal` of the *same* panel component into
 * its document body — so the panel keeps running in this tab's React tree and
 * shares the live Zustand store. We only sync the theme class across windows
 * and make sure every child closes when the parent tab unloads.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSyncExternalStore } from 'react';
import { PinOff, X, MonitorUp } from 'lucide-react';
import { useViewerStore } from '@/store';
import { getPanelDef } from '@/lib/panels/registry';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { PortalContainerProvider } from '@/components/ui/portal-container';
import {
  subscribePanelWindows,
  getPanelWindowsSnapshot,
  closePanelWindow,
  closeAllPanelWindows,
  syncPanelWindowsTheme,
  type PanelWindowEntry,
} from '@/services/panel-windows';

export function PanelWindowHost() {
  const windows = useSyncExternalStore(
    subscribePanelWindows,
    getPanelWindowsSnapshot,
    getPanelWindowsSnapshot,
  );
  const theme = useViewerStore((s) => s.theme);

  // Mirror the theme class (dark / colorful) onto every open window so toggling
  // the theme in the main tab updates the popped-out panels too.
  useEffect(() => {
    syncPanelWindowsTheme(document.documentElement.className);
  }, [theme, windows]);

  // Never orphan a child window: close them all when the parent tab unloads.
  useEffect(() => {
    const onUnload = () => closeAllPanelWindows();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      onUnload();
    };
  }, []);

  return (
    <>
      {windows.map((entry) => createPortal(<PanelWindowChrome entry={entry} />, entry.win.document.body, entry.id))}
    </>
  );
}

function PanelWindowChrome({ entry }: { entry: PanelWindowEntry }) {
  const def = getPanelDef(entry.id);
  const Icon = def?.Icon;
  const dock = () => useViewerStore.getState().showWorkspacePanel(entry.id);
  const close = () => closePanelWindow(entry.id);

  return (
    <PortalContainerProvider container={entry.win.document.body}>
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
      <div className="flex items-center gap-2 h-9 shrink-0 px-2 border-b border-border bg-muted/40 select-none">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        <span className="text-xs font-medium truncate flex-1 min-w-0">{def?.title ?? entry.id}</span>
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70 shrink-0">
          {entry.kind === 'pip' ? 'Picture-in-picture' : 'Window'}
        </span>
        <button
          type="button"
          title="Dock back into the sidebar"
          onClick={dock}
          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-muted transition-colors"
        >
          <PinOff className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Close window"
          onClick={close}
          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-muted transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">{renderPanelBody(entry.id, close)}</div>
      {/* Decorative hint strip — reinforces that this content is live. */}
      <div className="flex items-center gap-1.5 h-5 shrink-0 px-2 border-t border-border bg-muted/30 text-[9px] text-muted-foreground/70 select-none">
        <MonitorUp className="h-3 w-3" />
        <span>Live · synced with the main window</span>
      </div>
    </div>
    </PortalContainerProvider>
  );
}
