/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tab's one local-agent connection (#9523): a {@link BridgeClient}
 * serving the main viewer's tool host, read-only until the user allows edits
 * ({@link setAgentBridgePermission}), reporting into the eager UI state in
 * `./state`.
 *
 * Loaded with `import()` from the connect dialog after the user confirms, so
 * neither this module nor the tool host it imports is on the viewer's eager
 * path.
 */

import type { BimContext } from '@ifc-lite/sdk';
import type { BridgeToolDescriptor } from '@ifc-lite/mcp/bridge-protocol';
import { useViewerStore } from '@/store';
import {
  createMainViewerEditor, createMainViewerToolHost, dispatchMainViewerTool, mainViewerToolDefinitions,
} from '@/lib/agent-tools/main-viewer';
import type { ToolHost } from '@/lib/agent-tools/types';
import { BridgeClient, type BridgeClientOptions, type LocalNetworkPermission } from './client';
import {
  AGENT_BRIDGE_ACTIVITY_LIMIT, getAgentBridgeState, registerAgentBridgeControls, updateAgentBridgeState,
  type AgentBridgeActivity, type AgentBridgePermission, type AgentBridgeStatus,
} from './state';
import { isFramed } from './pairing-fragment';
import { ENDED_KEYS } from './outcome-keys';
import { toast } from '@/components/ui/toast';
import { registerEnglish } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { agentBridgeEn } from '@/i18n/catalogues/agent-bridge.en';

registerEnglish(agentBridgeEn);

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

const LOOPBACK_PAGE_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * The browser's permission for a public page to reach apps on this device:
 * `loopback-network` in Chrome 156 and Firefox 157. Older Chrome builds named
 * it `local-network-access` (or `local-network`); those names are asked only
 * when `loopback-network` is unknown, and only their `denied` is used, since
 * granting them does not open a socket to 127.0.0.1 in current browsers.
 *
 * A page that is itself on a loopback host never needs the permission, so its
 * `prompt` (the never-asked default) would wrongly suggest a pending prompt:
 * such pages report `unknown`.
 */
export async function queryLocalNetworkPermission(pageHost: string | undefined = typeof location === 'undefined' ? undefined : location.hostname): Promise<LocalNetworkPermission> {
  const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions;
  if (!permissions?.query) return 'unknown';
  const query = async (name: string): Promise<PermissionState | null> => {
    try {
      // Not in TypeScript's PermissionName union yet; an unknown name rejects, which is handled.
      return (await permissions.query({ name } as unknown as PermissionDescriptor)).state;
    } catch (err) {
      console.debug(`[agent-bridge] permission '${name}' is not known to this browser`, err);
      return null;
    }
  };
  const loopbackPage = pageHost !== undefined && LOOPBACK_PAGE_HOST.test(pageHost);
  const current = await query('loopback-network');
  if (current !== null) return loopbackPage && current === 'prompt' ? 'unknown' : current;
  for (const legacy of ['local-network-access', 'local-network']) {
    if ((await query(legacy)) === 'denied') return 'denied';
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

/** Rows not yet published to the UI state; flushed together so a burst of calls is one update. */
let pendingRows: AgentBridgeActivity[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const ACTIVITY_FLUSH_MS = 100;

function flushActivity(): void {
  flushTimer = null;
  if (pendingRows.length === 0) return;
  const rows = pendingRows.reverse();
  pendingRows = [];
  updateAgentBridgeState({ activity: [...rows, ...getAgentBridgeState().activity].slice(0, AGENT_BRIDGE_ACTIVITY_LIMIT) });
}

function resetActivity(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  pendingRows = [];
}

/** A live connection ended while no dialog is open: say so, never silently. */
function announceEnded(status: AgentBridgeStatus): void {
  if (status.kind !== 'disconnected' || getAgentBridgeState().dialog) return;
  toast.error(`${resolve('agentBridge.chip.ended')}: ${resolve(ENDED_KEYS[status.reason])}`, 'agent-bridge-ended');
}

/** Pair this tab with the bridge on `port`. Replaces any connection this tab had. Refused when framed. */
export function connectAgentBridge({ port, code, bim, WebSocket }: ConnectAgentBridgeOptions): void {
  if (isFramed()) {
    updateAgentBridgeState({ status: { kind: 'error', code: 'framed', port } });
    return;
  }
  active?.disconnect();
  const host = createMainViewerToolHost(useViewerStore, bim, { editor: createMainViewerEditor(useViewerStore) });
  resetActivity();
  updateAgentBridgeState({ activity: [] });
  let wasConnected = false;
  const client: BridgeClient = new BridgeClient({
    port,
    pairingCode: code,
    tools: mainViewerBridgeTools(),
    // The grant is read from the client at dispatch and again at the write: a revoke refuses what is not yet written.
    dispatch: (name, args, signal) => dispatchMainViewerTool(host, name, args, { signal, canEdit: () => client.canEditNow() }),
    modelIdFor: (args) => modelIdForCall(host, args),
    // The Vite define is absent under the Node test runner.
    clientInfo: { name: 'ifc-lite viewer', version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev' },
    WebSocket,
    probePermission: queryLocalNetworkPermission,
    onStatus: (status) => {
      if (active !== client) return;
      if (status.kind !== 'connected' && status.kind !== 'connecting') flushActivity();
      updateAgentBridgeState({ status });
      if (wasConnected) announceEnded(status);
      wasConnected = status.kind === 'connected';
    },
    onActivity: (entry) => {
      if (active !== client) return;
      pendingRows.push(entry);
      flushTimer ??= setTimeout(flushActivity, ACTIVITY_FLUSH_MS);
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
  resetActivity();
}

/** Allow or stop agent edits on the live connection (the "Allow the agent to edit" switch). */
export function setAgentBridgePermission(permission: AgentBridgePermission): void {
  active?.setPermission(permission);
}

/** Forget a finished connection's outcome (the user dismissed it). */
export function dismissAgentBridgeStatus(): void {
  const status = getAgentBridgeState().status;
  if (status.kind === 'connected' || status.kind === 'connecting') return;
  active = null;
  updateAgentBridgeState({ status: { kind: 'idle' }, activity: [] });
}

registerAgentBridgeControls({
  disconnect: disconnectAgentBridge, dismiss: dismissAgentBridgeStatus, setPermission: setAgentBridgePermission,
});
