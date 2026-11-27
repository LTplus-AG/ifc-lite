/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Eager mount points of the local agent bridge (#9523), both tiny: the
 * connect-dialog host in the viewer layout and the status-bar slot. Each
 * renders nothing until there is something to show and then loads its UI with
 * `import()`. Neither imports the bridge client or the tool host.
 */

import { useContext } from 'react';
import { BimReactContext } from '@/sdk/BimProvider';
import { savedTicket, saveTicket } from '@/lib/agent-bridge/resume';
import { isFramed } from '@/lib/agent-bridge/pairing-fragment';
import { listenForModelTabLinks } from '@/lib/agent-bridge/model-tabs';
import { isFeatureEnabled } from '@/lib/features';
import { Suspense, useEffect, useSyncExternalStore } from 'react';
import { lazyChunk } from '@/lib/lazy-chunk';
import { consumePendingPairingFragment, onPairingFragment } from '@/lib/agent-bridge/pairing-fragment';
import { closeAgentBridgeDialog, getAgentBridgeState, requestAgentBridgeDialog, useAgentBridgeState, type AgentBridgeStatus } from '@/lib/agent-bridge/state';
import { useViewerStore } from '@/store';
import { agentSurfaces } from '@/lib/agent-bridge/agent-surfaces';

const AgentBridgeDialog = lazyChunk(() => import('./AgentBridgeDialog').then((m) => ({ default: m.AgentBridgeDialog })));
/** A fresh dialog per request, so a second link re-seeds the code and port. */
const requestKeys = new WeakMap<object, number>();
let nextKey = 0;
function requestKey(request: object): number {
  let key = requestKeys.get(request);
  if (key === undefined) requestKeys.set(request, key = ++nextKey);
  return key;
}

const AgentBridgeChip = lazyChunk(() => import('./AgentBridgeChip').then((m) => ({ default: m.AgentBridgeChip })));
const AgentSurfacesDock = lazyChunk(() => import('./AgentSurfacesDock').then((m) => ({ default: m.AgentSurfacesDock })));
const AgentBridgeMobileIndicator = lazyChunk(() => import('./AgentBridgeMobileIndicator').then((m) => ({ default: m.AgentBridgeMobileIndicator })));

/** A live or just-ended connection is shown; a failed attempt stays in its dialog. */
function visible(status: AgentBridgeStatus): boolean {
  return status.kind === 'connecting' || status.kind === 'connected' || status.kind === 'disconnected';
}

/**
 * Opens the connect dialog when asked to, and for each pairing link the tab is
 * opened with. Mounted in every layout, so on the phone layout (no status bar)
 * it also shows the persistent connection indicator.
 */
export function AgentBridgeHost() {
  const { dialog, status } = useAgentBridgeState();
  const bim = useContext(BimReactContext);
  const isMobile = useViewerStore((s) => s.isMobile);
  // The bridge pairs a local AI agent, so it goes with the AI feature (`lib/features`).
  const enabled = isFeatureEnabled('ai.assistant');
  const hasSurfaces = useSyncExternalStore(agentSurfaces.subscribe, () => agentSurfaces.getSnapshot().length > 0);
  useEffect(() => {
    if (!enabled) return undefined;
    const take = () => {
      const fragment = consumePendingPairingFragment();
      if (fragment) requestAgentBridgeDialog({ source: 'link', fragment });
    };
    take();
    const stopTabs = listenForModelTabLinks();
    const stopLinks = onPairingFragment(take);
    return () => { stopTabs(); stopLinks(); };
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !bim || isFramed()) return;
    let cancelled = false;
    const resume = () => {
      const { status } = getAgentBridgeState();
      if (status.kind === 'connected' || status.kind === 'connecting') return;
      const ticket = savedTicket();
      if (!ticket) return;
      void import('@/lib/agent-bridge/session').then(({ connectAgentBridge }) => {
        if (!cancelled && !getAgentBridgeState().dialog && savedTicket()?.key === ticket.key) {
          connectAgentBridge({ port: ticket.port, code: ticket.key, resume: true, bim });
        }
      });
    };
    const navigation = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (navigation?.type === 'reload') resume();
    else if (navigation?.type === 'navigate' && getAgentBridgeState().status.kind === 'idle') saveTicket();
    const wake = () => { if (!document.hidden && getAgentBridgeState().status.kind === 'disconnected') resume(); };
    document.addEventListener('visibilitychange', wake);
    const restore = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
    window.addEventListener('pageshow', restore);
    window.addEventListener('online', resume);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('online', resume);
    };
  }, [enabled, bim]);
  if (!enabled) return null;
  return (
    <>
      {isMobile && visible(status) && <Suspense fallback={null}><AgentBridgeMobileIndicator /></Suspense>}
      {hasSurfaces && <Suspense fallback={null}><AgentSurfacesDock /></Suspense>}
      {dialog && <Suspense fallback={null}><AgentBridgeDialog key={requestKey(dialog)} request={dialog} onClose={closeAgentBridgeDialog} /></Suspense>}
    </>
  );
}

/** The desktop status-bar chip (the status bar exists only in the desktop layout). */
export function AgentBridgeStatusSlot() {
  const { status } = useAgentBridgeState();
  if (!visible(status) || !isFeatureEnabled('ai.assistant')) return null;
  return <Suspense fallback={null}><AgentBridgeChip /></Suspense>;
}
