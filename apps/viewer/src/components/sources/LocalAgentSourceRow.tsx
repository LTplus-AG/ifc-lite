/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Sources panel's "Local agent" row (#9523): not a file source, but the
 * other way a model gets a counterpart off the page, so it sits with them.
 * It only opens the connect dialog; nothing connects from here.
 */

import { Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { registerEnglish, useTranslation } from '@/i18n';
import { agentBridgeEn } from '@/i18n/catalogues/agent-bridge.en';
import { requestAgentBridgeDialog, useAgentBridgeState } from '@/lib/agent-bridge/state';

registerEnglish(agentBridgeEn);

export function LocalAgentSourceRow() {
  const { t } = useTranslation();
  const { status } = useAgentBridgeState();
  return (
    <section className="mt-3 flex items-start gap-3 rounded border p-3" data-local-agent-row>
      <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="text-sm font-medium">{t('agentBridge.row.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('agentBridge.row.description')}</p>
        {status.kind === 'connected' && <p className="text-xs text-status-ok">{t('agentBridge.chip.connected')}</p>}
      </div>
      <Button size="sm" variant="outline" disabled={status.kind === 'connecting' || status.kind === 'connected'}
        onClick={() => requestAgentBridgeDialog({ source: 'manual' })}>
        {t('agentBridge.row.connect')}
      </Button>
    </section>
  );
}
