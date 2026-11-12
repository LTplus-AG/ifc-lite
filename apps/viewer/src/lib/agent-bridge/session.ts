/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tab's one local-agent connection (#9523): a {@link BridgeClient}
 * serving the main viewer's read-only tool host, reporting into the eager
 * UI state in `./state`.
 *
 * Loaded with `import()` from the connect dialog after the user confirms, so
 * neither this module nor the tool host it imports is on the viewer's eager
 * path.
 */

import type { BimContext } from '@ifc-lite/sdk';
import type { BridgeToolDescriptor } from '@ifc-lite/mcp/bridge-protocol';
import { useViewerStore } from '@/store';
import { createMainViewerToolHost, dispatchMainViewerTool, mainViewerToolDefinitions } from '@/lib/agent-tools/main-viewer';
import type { ToolHost } from '@/lib/agent-tools/types';
import { BridgeClient, type BridgeClientOptions, type LocalNetworkPermission } from './client';
import { AGENT_BRIDGE_ACTIVITY_LIMIT, getAgentBridgeState, updateAgentBridgeState } from './state';

let active: BridgeClient | null = null;

/** The model a call is routed to: its `model_id`, or the only loaded model. */
export function modelIdForCall(host: ToolHost, args: Record<string, unknown>): string | null {
  if (typeof args.model_id === 'string' && args.model_id.trim()) return args.model_id.trim();
  const models = host.models();
  return models.length === 1 ? models[0].id : null;
}

/** The main viewer's tools, as the bridge's `hello` lists them. */
export function mainViewerBridgeTools(): BridgeToolDescriptor[] {
  return mainViewerToolDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
    readOnly: tool.readOnly,
  }));
}

/** Chrome's Local Network Access permission, under the names Chrome has shipped it as. */
export async function queryLocalNetworkPermission(): Promise<LocalNetworkPermission> {
  const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions;
  if (!permissions?.query) return 'unknown';
  for (const name of ['loopback-network', 'local-network-access', 'local-network']) {
    try {
      // Not in TypeScript's PermissionName union yet; unknown names reject, which is handled.
      const status = await permissions.query({ name } as unknown as PermissionDescriptor);
      return status.state;
    } catch (err) {
      console.debug(`[agent-bridge] permission '${name}' is not known to this browser`, err);
    }
  }
  return 'unknown';
}

export interface ConnectAgentBridgeOptions {
  port: number;
  code: string;
  bim: BimContext;
  /** Test seam; the browser's `WebSocket` otherwise. */
  WebSocket?: BridgeClientOptions['WebSocket'];
}

/** Pair this tab with the bridge on `port`. Replaces any connection this tab had. */
export function connectAgentBridge({ port, code, bim, WebSocket }: ConnectAgentBridgeOptions): void {
  active?.disconnect();
  const host = createMainViewerToolHost(useViewerStore, bim);
  updateAgentBridgeState({ activity: [] });
  const client = new BridgeClient({
    port,
    pairingCode: code,
    tools: mainViewerBridgeTools(),
    dispatch: (name, args, signal) => dispatchMainViewerTool(host, name, args, { signal }),
    modelIdFor: (args) => modelIdForCall(host, args),
    // The Vite define is absent under the Node test runner.
    clientInfo: { name: 'ifc-lite viewer', version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev' },
    WebSocket,
    probePermission: queryLocalNetworkPermission,
    onStatus: (status) => {
      if (active === client) updateAgentBridgeState({ status });
    },
    onActivity: (entry) => {
      if (active !== client) return;
      const activity = [entry, ...getAgentBridgeState().activity].slice(0, AGENT_BRIDGE_ACTIVITY_LIMIT);
      updateAgentBridgeState({ activity });
    },
  });
  active = client;
  client.connect();
}

/** Close the connection at the user's request. */
export function disconnectAgentBridge(): void {
  const client = active;
  if (!client) {
    updateAgentBridgeState({ status: { kind: 'idle' } });
    return;
  }
  client.disconnect();
  active = null;
}

/** Forget a finished connection's outcome (the user dismissed it). */
export function dismissAgentBridgeStatus(): void {
  const status = getAgentBridgeState().status;
  if (status.kind === 'connected' || status.kind === 'connecting') return;
  active = null;
  updateAgentBridgeState({ status: { kind: 'idle' }, activity: [] });
}
