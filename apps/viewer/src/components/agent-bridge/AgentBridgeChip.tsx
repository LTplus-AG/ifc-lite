/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The status-bar chip of a local agent connection (#9523): "Local agent
 * connected · read-only" while paired, with Disconnect and the activity log
 * one click away; after a drop it says why and offers to pair again. Loaded
 * with `import()` only once a connection exists.
 */

import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { getLocale, registerEnglish, useTranslation } from '@/i18n';
import { formatLocaleDate } from '@/i18n/intlFormat';
import { agentBridgeEn } from '@/i18n/catalogues/agent-bridge.en';
import { requestAgentBridgeDialog, useAgentBridgeState, type AgentBridgeActivity } from '@/lib/agent-bridge/state';
import { disconnectAgentBridge, dismissAgentBridgeStatus } from '@/lib/agent-bridge/session';
import { AgentBridgeOutcome } from './AgentBridgeOutcome';

registerEnglish(agentBridgeEn);

function ActivityRow({ entry }: { entry: AgentBridgeActivity }) {
  const { t } = useTranslation();
  const outcome = entry.outcome === 'ok' ? t('agentBridge.panel.ok')
    : entry.outcome === 'cancelled' ? t('agentBridge.panel.cancelled')
      : t('agentBridge.panel.error', { code: entry.errorCode ?? '' });
  return (
    <li className="flex items-baseline gap-2 py-0.5 text-xs" data-agent-bridge-activity={entry.outcome}>
      <span className="min-w-0 flex-1 truncate font-mono">{entry.tool}</span>
      <span className="max-w-24 truncate text-muted-foreground">{entry.modelId ?? t('agentBridge.panel.noModel')}</span>
      <span className="tabular-nums text-muted-foreground">{t('agentBridge.panel.duration', { ms: Math.round(entry.durationMs) })}</span>
      <span className={cn(entry.outcome === 'error' && 'text-destructive')}>{outcome}</span>
    </li>
  );
}

export function AgentBridgeChip() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { status, activity } = useAgentBridgeState();
  const connected = status.kind === 'connected';
  const label = connected ? t('agentBridge.chip.connected')
    : status.kind === 'connecting' ? t('agentBridge.chip.connecting') : t('agentBridge.chip.ended');
  return (<>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" title={t('agentBridge.chip.title')} data-agent-bridge-chip={status.kind}
          className={cn(
            // Status-bar text metrics, with the same hit-slop idiom as its other chips (#5826).
            'relative h-auto gap-1.5 rounded px-1 -mx-1 py-0 text-xs font-normal after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-[\'\']',
            connected ? 'text-foreground' : status.kind === 'disconnected' && 'text-destructive',
          )}>
          <Bot className={cn('h-3.5 w-3.5', connected && 'text-status-ok')} aria-hidden />
          <span>{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="flex w-96 flex-col gap-3 p-3 text-sm">
        <p className="font-medium">{label}</p>
        {status.kind === 'connected' && (
          <p className="text-xs text-muted-foreground">
            {t('agentBridge.panel.since', {
              port: status.port,
              time: formatLocaleDate(getLocale(), new Date(status.since), { hour: '2-digit', minute: '2-digit' }),
            })}
          </p>
        )}
        <AgentBridgeOutcome status={status} />
        <div className="flex justify-end gap-2">
          {status.kind === 'disconnected' ? (
            <>
              <Button size="sm" variant="outline" onClick={() => { dismissAgentBridgeStatus(); setOpen(false); }}>
                {t('agentBridge.panel.dismiss')}
              </Button>
              <Button size="sm" onClick={() => { setOpen(false); requestAgentBridgeDialog({ source: 'manual' }); }}>
                {t('agentBridge.panel.pairAgain')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => { disconnectAgentBridge(); setOpen(false); }}
              data-agent-bridge-disconnect>
              {t('agentBridge.panel.disconnect')}
            </Button>
          )}
        </div>
        <section className="flex flex-col gap-1 border-t pt-2">
          <h3 className="text-xs font-medium">{t('agentBridge.panel.activity')}</h3>
          <p className="text-xs text-muted-foreground">{t('agentBridge.panel.activityNote')}</p>
          {activity.length === 0
            ? <p className="text-xs text-muted-foreground">{t('agentBridge.panel.noActivity')}</p>
            : <ul className="max-h-64 overflow-y-auto">{activity.map((entry) => <ActivityRow key={entry.seq} entry={entry} />)}</ul>}
        </section>
      </PopoverContent>
    </Popover>
    {/* Trailing separator, as the workspace chip beside it does. */}
    <Separator orientation="vertical" className="h-3.5" />
  </>);
}
