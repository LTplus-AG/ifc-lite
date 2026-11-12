/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Eager mount points of the local agent bridge (#9523), both tiny: the
 * connect-dialog host in the viewer layout and the status-bar slot. Each
 * renders nothing until there is something to show and then loads its UI with
 * `import()`. Neither imports the bridge client or the tool host.
 */

import { lazy, Suspense, useEffect } from 'react';
import { consumePendingPairingFragment, onPairingFragment } from '@/lib/agent-bridge/pairing-fragment';
import { closeAgentBridgeDialog, requestAgentBridgeDialog, useAgentBridgeState } from '@/lib/agent-bridge/state';

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

/** Opens the connect dialog when asked to, and for each pairing link the tab is opened with. */
export function AgentBridgeHost() {
  const { dialog } = useAgentBridgeState();
  useEffect(() => {
    const take = () => {
      const fragment = consumePendingPairingFragment();
      if (fragment) requestAgentBridgeDialog({ source: 'link', fragment });
    };
    take();
    return onPairingFragment(take);
  }, []);
  if (!dialog) return null;
  return <Suspense fallback={null}><AgentBridgeDialog key={requestKey(dialog)} request={dialog} onClose={closeAgentBridgeDialog} /></Suspense>;
}

/** The status-bar chip while a connection is live or has just ended. A failed attempt stays in its dialog. */
export function AgentBridgeStatusSlot() {
  const { status } = useAgentBridgeState();
  if (status.kind === 'idle' || status.kind === 'error') return null;
  return <Suspense fallback={null}><AgentBridgeChip /></Suspense>;
}
