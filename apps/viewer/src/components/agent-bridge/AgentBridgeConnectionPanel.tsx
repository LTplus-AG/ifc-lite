/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a live (or just ended) local-agent connection shows wherever it is
 * surfaced (#9523): the status-bar chip, the Sources panel row and the phone
 * layout's indicator. The status, the "Allow the agent to edit" switch (off
 * at every pairing), Disconnect (or Pair again / Dismiss after a drop), and
 * the activity log, where edits stand out and say what they changed. A live
 * socket is always one tap from Disconnect, in every layout.
 */

import { useId } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { getLocale, registerEnglish, useTranslation } from '@/i18n';
import { formatLocaleDate } from '@/i18n/intlFormat';
import { agentBridgeEn } from '@/i18n/catalogues/agent-bridge.en';
import {
  disconnectLiveAgentBridge, dismissAgentBridgeOutcome, requestAgentBridgeDialog, setLiveAgentBridgePermission,
  useAgentBridgeState, type AgentBridgeActivity, type AgentBridgeEdit, type AgentBridgeStatus,
} from '@/lib/agent-bridge/state';
import { AgentBridgeOutcome } from './AgentBridgeOutcome';

registerEnglish(agentBridgeEn);

const shown = (value: AgentBridgeEdit['before']): string =>
  value === null ? '—' : typeof value === 'string' ? `“${value}”` : String(value);

/** One line saying what an applied edit changed. */
function EditSummary({ edit }: { edit: AgentBridgeEdit }) {
  const { t } = useTranslation();
  const values = {
    entity: `${edit.entityType} #${edit.expressId}`, field: edit.field, before: shown(edit.before), after: shown(edit.after),
  };
  const text = !edit.changed ? t('agentBridge.panel.editUnchanged', values)
    : edit.after === null ? t('agentBridge.panel.editDeleted', values) : t('agentBridge.panel.editChange', values);
  return <span className="block truncate pl-5 text-muted-foreground" title={text}>{text}</span>;
}

function ActivityRow({ entry }: { entry: AgentBridgeActivity }) {
  const { t } = useTranslation();
  const outcome = entry.outcome === 'ok' ? t('agentBridge.panel.ok')
    : entry.outcome === 'cancelled' ? t('agentBridge.panel.cancelled')
      : t('agentBridge.panel.error', { code: entry.errorCode ?? '' });
  return (
    <li className={cn('py-0.5 text-xs', entry.mutating && 'rounded bg-status-warn/10 px-1')}
      data-agent-bridge-activity={entry.outcome} data-agent-bridge-edit={entry.mutating ? (entry.edit?.changed ? 'applied' : 'not-applied') : undefined}>
      <span className="flex items-baseline gap-2">
        {entry.mutating
          ? <Pencil className="h-3 w-3 shrink-0 self-center text-status-warn" aria-label={t('agentBridge.panel.edit')} />
          : null}
        <span className="min-w-0 flex-1 truncate font-mono">{entry.tool}</span>
        <span className="max-w-24 truncate text-muted-foreground">{entry.modelId ?? t('agentBridge.panel.noModel')}</span>
        <span className="tabular-nums text-muted-foreground">{t('agentBridge.panel.duration', { ms: Math.round(entry.durationMs) })}</span>
        <span className={cn(entry.outcome === 'error' && 'text-destructive')}>{outcome}</span>
      </span>
      {entry.edit && <EditSummary edit={entry.edit} />}
    </li>
  );
}

/** The opt-in to agent edits: off at every pairing, revocable at any time. */
function AllowEditsSwitch({ status }: { status: Extract<AgentBridgeStatus, { kind: 'connected' }> }) {
  const { t } = useTranslation();
  const id = useId();
  const hint = `${id}-hint`;
  return (
    <div className="flex items-start gap-2 rounded border p-2">
      <Switch id={id} checked={status.permission === 'read-write'} disabled={status.readOnlyCeiling} aria-describedby={hint}
        onCheckedChange={(on) => setLiveAgentBridgePermission(on ? 'read-write' : 'read-only')} data-agent-bridge-allow-edits />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-xs font-medium">{t('agentBridge.panel.allowEdits')}</label>
        <p id={hint} className="text-xs text-muted-foreground">
          {status.readOnlyCeiling ? t('agentBridge.panel.editsCeiling') : t('agentBridge.panel.allowEditsHint')}
        </p>
      </div>
    </div>
  );
}

export function AgentBridgeActivityLog() {
  const { t } = useTranslation();
  const { activity } = useAgentBridgeState();
  return (
    <section className="flex flex-col gap-1 border-t pt-2">
      <h3 className="text-xs font-medium">{t('agentBridge.panel.activity')}</h3>
      <p className="text-xs text-muted-foreground">{t('agentBridge.panel.activityNote')}</p>
      {activity.length === 0
        ? <p className="text-xs text-muted-foreground">{t('agentBridge.panel.noActivity')}</p>
        : <ul className="max-h-64 overflow-y-auto">{activity.map((entry) => <ActivityRow key={entry.seq} entry={entry} />)}</ul>}
    </section>
  );
}

/** The connection's label, as every surface shows it. */
export function useAgentBridgeLabel(): string {
  const { t } = useTranslation();
  const { status } = useAgentBridgeState();
  if (status.kind === 'connected') return t(status.permission === 'read-write' ? 'agentBridge.chip.connectedEdits' : 'agentBridge.chip.connected');
  return status.kind === 'connecting' ? t('agentBridge.chip.connecting') : t('agentBridge.chip.ended');
}

export interface AgentBridgeConnectionPanelProps {
  /** Called after an action that should close the surrounding popover or dialog. */
  onDone?: () => void;
  /** False hides the activity log (the Sources row shows it behind a toggle). */
  showActivity?: boolean;
}

export function AgentBridgeConnectionPanel({ onDone, showActivity = true }: AgentBridgeConnectionPanelProps) {
  const { t } = useTranslation();
  const { status } = useAgentBridgeState();
  const label = useAgentBridgeLabel();
  return (
    <div className="flex flex-col gap-3 text-sm" data-agent-bridge-panel={status.kind}>
      <p className="font-medium">{label}</p>
      {status.kind === 'connected' && (<>
        <p className="text-xs text-muted-foreground">
          {t(status.permission === 'read-write' ? 'agentBridge.panel.sinceEdits' : 'agentBridge.panel.since', {
            port: status.port,
            time: formatLocaleDate(getLocale(), new Date(status.since), { hour: '2-digit', minute: '2-digit' }),
          })}
        </p>
        <AllowEditsSwitch status={status} />
      </>)}
      <AgentBridgeOutcome status={status} />
      <div className="flex justify-end gap-2">
        {status.kind === 'disconnected' ? (
          <>
            <Button size="sm" variant="outline" onClick={() => { dismissAgentBridgeOutcome(); onDone?.(); }}>
              {t('agentBridge.panel.dismiss')}
            </Button>
            <Button size="sm" onClick={() => { onDone?.(); requestAgentBridgeDialog({ source: 'manual' }); }}>
              {t('agentBridge.panel.pairAgain')}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => { disconnectLiveAgentBridge(); onDone?.(); }}
            data-agent-bridge-disconnect>
            {t('agentBridge.panel.disconnect')}
          </Button>
        )}
      </div>
      {showActivity && <AgentBridgeActivityLog />}
    </div>
  );
}
