/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { AlertTriangle, ArrowLeftRight, ArrowUpRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { panelTitleKey } from '@/lib/panels/registry';
import type { SavedConversation } from '@/lib/assistant/persistence';
import { EvidenceView, sourceAvailability, UNAVAILABLE } from '../analysis/EvidenceView';

type EvidenceState = 'captured' | 'stale' | 'historical';
const STATE_LABEL = { captured: 'assistant.stateCaptured', stale: 'assistant.stateStale', historical: 'assistant.stateHistorical' } as const;
const STATE_TONE: Record<EvidenceState, string> = {
  captured: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  stale: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  historical: 'bg-muted text-muted-foreground',
};

/** One-glance scope of what the assistant sees; full caveats stay in Evidence details. */
export function EvidenceSummary({ evidence, state, onReturn, onRefresh, onChange }: {
  evidence: SavedConversation['evidence'];
  state: EvidenceState;
  onReturn: () => void;
  onRefresh: () => void;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const availability = useMemo(() => sourceAvailability(evidence.payload), [evidence.payload]);
  const scope = availability === 'unavailable' ? t(UNAVAILABLE[evidence.source])
    : availability === 'available' && evidence.totalRows === 0 ? t('assistant.evidenceEmpty')
      : t('assistant.attachedRows', { included: evidence.includedRows, total: evidence.totalRows });
  return <div className="border-b border-border p-3 space-y-2 text-xs">
    <div className="flex items-center gap-2 min-w-0">
      <span className="font-semibold truncate">{t(panelTitleKey(evidence.source))}</span>
      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium', STATE_TONE[state])}>{t(STATE_LABEL[state])}</span>
      <div className="ml-auto flex shrink-0 items-center">
        <IconButton label={t('assistant.changeSource')} className="h-7 w-7" onClick={onChange}><ArrowLeftRight className="h-3.5 w-3.5" /></IconButton>
        <IconButton label={t('assistant.returnSource')} className="h-7 w-7" onClick={onReturn}><ArrowUpRight className="h-3.5 w-3.5" /></IconButton>
        <IconButton label={t('assistant.refresh')} className="h-7 w-7" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></IconButton>
      </div>
    </div>
    <p className={cn(availability === 'unavailable' && 'text-amber-700 dark:text-amber-400')}>{scope}</p>
    {evidence.includedRows < evidence.totalRows && <p className="text-muted-foreground">{t('assistant.attachedSample')}</p>}
    {state === 'stale' && <div aria-live="polite" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-2">
      <p className="flex items-start gap-1.5 font-medium text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" aria-hidden="true" />{t('assistant.staleTitle')}
      </p>
      <p>{t('assistant.stale')}</p>
      <Button size="sm" className="h-7" onClick={onRefresh}><RefreshCw className="h-3 w-3 mr-1" />{t('assistant.refreshShort')}</Button>
    </div>}
    <details className="group">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('assistant.evidenceDetails')}</summary>
      <div className="mt-2"><EvidenceView evidence={evidence} state={state} /></div>
    </details>
  </div>;
}
