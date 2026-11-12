/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Why a local-agent connection failed or ended, in words the user can act on
 * (#9523), plus the command that starts the bridge when nothing answered.
 * Shared by the connect dialog and the status-bar chip.
 */

import { AlertCircle } from 'lucide-react';
import { DEFAULT_BRIDGE_PORT, DEFAULT_BRIDGE_VIEWER_URL } from '@ifc-lite/mcp/bridge-protocol';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { AgentBridgeDisconnectReason, AgentBridgeErrorCode, AgentBridgeStatus } from '@/lib/agent-bridge/state';

const ERROR_KEYS: Record<AgentBridgeErrorCode, TranslationKey> = {
  unreachable: 'agentBridge.failure.unreachable',
  'permission-denied': 'agentBridge.failure.permissionDenied',
  'pairing-failed': 'agentBridge.failure.pairingFailed',
  'protocol-mismatch': 'agentBridge.failure.protocolMismatch',
  'handshake-timeout': 'agentBridge.failure.handshakeTimeout',
  'invalid-message': 'agentBridge.failure.invalidMessage',
  busy: 'agentBridge.failure.busy',
  'invalid-link': 'agentBridge.failure.invalidLink',
};

const ENDED_KEYS: Record<AgentBridgeDisconnectReason, TranslationKey> = {
  replaced: 'agentBridge.ended.replaced',
  'bridge-shutdown': 'agentBridge.ended.bridgeShutdown',
  'connection-lost': 'agentBridge.ended.connectionLost',
  'page-hidden': 'agentBridge.ended.pageHidden',
};

function pageOrigin(): string {
  return typeof location === 'undefined' ? DEFAULT_BRIDGE_VIEWER_URL : location.origin;
}

/** The command that starts a bridge this page can pair with. */
export function bridgeStartCommand(port: number, origin: string = pageOrigin()): string {
  const parts = ['npx @ifc-lite/mcp --bridge'];
  if (port !== DEFAULT_BRIDGE_PORT) parts.push(`--bridge-port ${port}`);
  if (origin !== DEFAULT_BRIDGE_VIEWER_URL) parts.push(`--bridge-viewer-url ${origin}`);
  return parts.join(' ');
}

export function BridgeStartCommand({ port }: { port: number }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border bg-muted px-2 py-1.5 font-mono text-xs">
      {bridgeStartCommand(port)}
    </pre>
  );
}

/** The explanation for a failed or ended connection; nothing for any other status. */
export function AgentBridgeOutcome({ status }: { status: AgentBridgeStatus }) {
  const { t } = useTranslation();
  if (status.kind !== 'error' && status.kind !== 'disconnected') return null;
  const port = status.kind === 'error' ? status.port ?? DEFAULT_BRIDGE_PORT : DEFAULT_BRIDGE_PORT;
  const origin = pageOrigin();
  const message = status.kind === 'error' ? t(ERROR_KEYS[status.code], { port }) : t(ENDED_KEYS[status.reason]);
  return (
    <div role="alert" data-agent-bridge-outcome={status.kind === 'error' ? status.code : status.reason}
      className="flex flex-col gap-2 rounded border border-destructive/40 p-2 text-xs">
      <p className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
        <span>{message}</span>
      </p>
      {status.kind === 'error' && status.code === 'unreachable' && (
        <>
          <BridgeStartCommand port={port} />
          {origin !== DEFAULT_BRIDGE_VIEWER_URL && (
            <p className="text-muted-foreground">{t('agentBridge.failure.origin', { origin })}</p>
          )}
        </>
      )}
    </div>
  );
}
