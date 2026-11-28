/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { requestAgentBridgeDialog } from './state';
import { isFramed } from './pairing-fragment';

export function openModelTabPort(): MessagePort | undefined {
  if (isFramed() || typeof SharedWorker === 'undefined') return;
  try {
    return new SharedWorker(new URL('./model-tabs.worker.ts', import.meta.url), { type: 'module' }).port;
  } catch (err) {
    console.debug('[agent-bridge] model tab discovery unavailable', err);
    return;
  }
}

export function hasModelForPairing(state: ReturnType<typeof useViewerStore.getState>): boolean {
  return state.models.size > 0 || Boolean(state.ifcDataStore);
}

export function listenForModelTabLinks(): () => void {
  const port = openModelTabPort();
  if (!port) return () => {};
  port.onmessage = ({ data }) => {
    const state = useViewerStore.getState();
    if (!hasModelForPairing(state)) return;
    if (data.type === 'query') {
      const name = [...state.models.values()].map((m) => m.name).join(', ') || document.title || 'IFC';
      port.postMessage({ type: 'offer', to: data.from, name: name.slice(0, 240) });
    } else if (data.type === 'prepare') {
      port.postMessage({ type: 'ready', to: data.from, attemptId: data.attemptId });
    } else if (data.type === 'deliver' && typeof data.fragment === 'string') {
      requestAgentBridgeDialog({ source: 'link', fragment: data.fragment });
      window.focus();
    }
  };
  return () => { port.postMessage({ type: 'leave' }); port.close(); };
}
