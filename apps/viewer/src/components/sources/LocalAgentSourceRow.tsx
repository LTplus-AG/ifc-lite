/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Sources panel's "Local agent" row (#9523): not a file source, but the
 * other way a model gets a counterpart off the page, so it sits with them.
 * Idle, it opens the connect dialog; nothing connects from here. With a live
 * or just-ended connection it shows the same connection panel as the
 * status-bar chip (Disconnect, activity), so the row works in every layout.
 * A framed viewer never connects, and the row says why.
 */

import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { requestAgentBridgeDialog, useAgentBridgeState } from '@/lib/agent-bridge/state';
import { isFramed } from '@/lib/agent-bridge/pairing-fragment';
import { AgentBridgeActivityLog, AgentBridgeConnectionPanel } from '@/components/agent-bridge/AgentBridgeConnectionPanel';

export function LocalAgentSourceRow() {
  const { t } = useTranslation();
  const { status } = useAgentBridgeState();
  const [activityOpen, setActivityOpen] = useState(false);
  const framed = isFramed();
  const live = status.kind === 'connecting' || status.kind === 'connected' || status.kind === 'disconnected';
  return (
    <section className="mt-3 flex flex-col gap-2 rounded border p-3" data-local-agent-row={status.kind}>
      <div className="flex items-start gap-3">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-sm font-medium">{t('agentBridge.row.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('agentBridge.row.description')}</p>
          {framed && <p className="text-xs text-muted-foreground" data-local-agent-framed>{t('agentBridge.failure.framed')}</p>}
        </div>
        {!live && (
          <Button size="sm" variant="outline" disabled={framed} onClick={() => requestAgentBridgeDialog({ source: 'manual' })}>
            {t('agentBridge.row.connect')}
          </Button>
        )}
      </div>
      {live && (
        <>
          <AgentBridgeConnectionPanel showActivity={false} />
          <Button size="sm" variant="ghost" className="self-start" aria-expanded={activityOpen}
            onClick={() => setActivityOpen((open) => !open)}>
            {activityOpen ? t('agentBridge.row.hideActivity') : t('agentBridge.row.showActivity')}
          </Button>
          {activityOpen && <AgentBridgeActivityLog />}
        </>
      )}
    </section>
  );
}
