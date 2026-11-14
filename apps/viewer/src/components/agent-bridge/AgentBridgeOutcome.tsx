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
import { useTranslation } from '@/i18n';
import type { AgentBridgeStatus } from '@/lib/agent-bridge/state';
import { ENDED_KEYS, ERROR_KEYS } from '@/lib/agent-bridge/outcome-keys';

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
    <>
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
      {/* Its own live region, outside the alert: it arrives a moment later (the permission probe) and must not re-announce the alert. */}
      {status.kind === 'error' && status.code === 'unreachable' && status.permission === 'prompt' && (
        <output className="block text-xs" data-agent-bridge-permission-hint>{t('agentBridge.failure.permissionPrompt')}</output>
      )}
    </>
  );
}
