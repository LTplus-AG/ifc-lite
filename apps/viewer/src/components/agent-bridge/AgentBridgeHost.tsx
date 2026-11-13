/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Eager mount points of the local agent bridge (#9523), both tiny: the
 * connect-dialog host in the viewer layout and the status-bar slot. Each
 * renders nothing until there is something to show and then loads its UI with
 * `import()`. Neither imports the bridge client or the tool host.
 */

import { isFeatureEnabled } from '@/lib/features';
import { lazy, Suspense, useEffect } from 'react';
import { consumePendingPairingFragment, onPairingFragment } from '@/lib/agent-bridge/pairing-fragment';
import { closeAgentBridgeDialog, requestAgentBridgeDialog, useAgentBridgeState, type AgentBridgeStatus } from '@/lib/agent-bridge/state';
import { useViewerStore } from '@/store';

const AgentBridgeDialog = lazy(() => import('./AgentBridgeDialog').then((m) => ({ default: m.AgentBridgeDialog })));
/** A fresh dialog per request, so a second link re-seeds the code and port. */
const requestKeys = new WeakMap<object, number>();
let nextKey = 0;
function requestKey(request: object): number {
  let key = requestKeys.get(request);
  if (key === undefined) requestKeys.set(request, key = ++nextKey);
  return key;
}

const AgentBridgeChip = lazy(() => import('./AgentBridgeChip').then((m) => ({ default: m.AgentBridgeChip })));
const AgentBridgeMobileIndicator = lazy(() => import('./AgentBridgeMobileIndicator').then((m) => ({ default: m.AgentBridgeMobileIndicator })));

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
  const isMobile = useViewerStore((s) => s.isMobile);
  // The bridge pairs a local AI agent, so it goes with the AI feature (`lib/features`).
  const enabled = isFeatureEnabled('ai.assistant');
  useEffect(() => {
    if (!enabled) return undefined;
    const take = () => {
      const fragment = consumePendingPairingFragment();
      if (fragment) requestAgentBridgeDialog({ source: 'link', fragment });
    };
    take();
    return onPairingFragment(take);
  }, [enabled]);
  if (!enabled) return null;
  return (
    <>
      {isMobile && visible(status) && <Suspense fallback={null}><AgentBridgeMobileIndicator /></Suspense>}
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
