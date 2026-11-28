/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Suspense } from 'react';
import { isFeatureEnabled } from '@/lib/features';
import { lazyChunk } from '@/lib/lazy-chunk';
import { useAgentBridgeState, type AgentBridgeStatus } from '@/lib/agent-bridge/state';

const AgentBridgeChip = lazyChunk(() => import('./AgentBridgeChip').then((m) => ({ default: m.AgentBridgeChip })));

/** A live or just-ended connection is shown; a failed attempt stays in its dialog. */
export function visible(status: AgentBridgeStatus): boolean {
  return status.kind === 'connecting' || status.kind === 'connected' || status.kind === 'disconnected';
}

/** The desktop status-bar chip (the status bar exists only in the desktop layout). */
export function AgentBridgeStatusSlot() {
  const { status } = useAgentBridgeState();
  if (!visible(status) || !isFeatureEnabled('ai.assistant')) return null;
  return <Suspense fallback={null}><AgentBridgeChip /></Suspense>;
}
