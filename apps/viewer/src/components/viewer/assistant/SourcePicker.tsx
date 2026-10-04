/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { ArrowUpRight, MessageSquare, Play } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { useClash } from '@/hooks/useClash';
import { usePanelControls } from '@/hooks/usePanelControls';
import { panelTitleKey } from '@/lib/panels/registry';
import { ASSISTANT_SOURCES, type AssistantSource } from '@/lib/assistant/sources';

type Readiness = { status: string; ready: boolean; run?: boolean; running?: boolean };

const DESCRIPTION: Record<AssistantSource, TranslationKey> = {
  clash: 'assistant.pickClashDescription', validation: 'assistant.pickValidationDescription',
  compare: 'assistant.pickCompareDescription', flow: 'assistant.pickFlowDescription', loadReport: 'assistant.pickLoadReportDescription',
};

/** Live native status per source: what the assistant would see if attached now. */
function useReadiness(): Record<AssistantSource, Readiness> {
  const { t } = useTranslation();
  const models = useViewerStore(s => s.models.size);
  const clash = useViewerStore(s => s.clashResult);
  const clashRunning = useViewerStore(s => s.clashRunning);
  const validation = useViewerStore(s => s.idsValidationReport);
  const compare = useViewerStore(s => s.compareResult);
  const flow = useViewerStore(s => s.flowDoc);
  return {
    clash: clashRunning ? { status: t('assistant.pickRunning'), ready: false, running: true }
      : clash ? { status: t('assistant.pickFindings', { count: clash.clashes.length }), ready: true }
        : { status: t('assistant.pickNotRun'), ready: false, run: models > 0 },
    validation: validation
      ? { status: t('assistant.pickSpecifications', { count: validation.specificationResults.length }), ready: true }
      : { status: t('assistant.pickNoReport'), ready: false },
    compare: compare ? { status: t('assistant.pickChanges', { count: compare.diff.entries.length }), ready: true }
      : { status: t(models < 2 ? 'assistant.pickNeedsTwoModels' : 'assistant.pickNotRun'), ready: false },
    flow: flow ? { status: t('assistant.pickGraph', { name: flow.name, count: flow.nodes.length }), ready: true }
      : { status: t('assistant.pickNoGraph'), ready: false },
    loadReport: models ? { status: t('assistant.pickModels', { count: models }), ready: true } : { status: t('assistant.pickNoModels'), ready: false },
  };
}

/** Start in the Assistant: choose what to discuss, or run/open the native source that produces it. */
export function SourcePicker({ current, onAttach, onCancel }: {
  current: AssistantSource | null;
  onAttach: (source: AssistantSource) => void;
  onCancel: (() => void) | null;
}) {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const readiness = useReadiness();
  const { runAll } = useClash();
  const [error, setError] = useState<string | null>(null);
  const runClash = async () => {
    setError(null);
    try {
      await runAll();
      if (useViewerStore.getState().clashResult) onAttach('clash');
      else setError(useViewerStore.getState().clashError ?? t('assistant.pickRunFailed'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return <div className="p-3 space-y-2 text-xs">
    <div className="flex items-baseline justify-between gap-2">
      <p className="font-semibold">{t('assistant.pickTitle')}</p>
      {onCancel && <Button variant="ghost" size="sm" className="h-6 px-2" onClick={onCancel}>{t('assistant.cancel')}</Button>}
    </div>
    <p className="text-muted-foreground">{t('assistant.pickHint')}</p>
    <ul className="space-y-1.5">
      {ASSISTANT_SOURCES.map(source => {
        const state = readiness[source];
        const title = t(panelTitleKey(source));
        return <li key={source} className="rounded border border-border p-2 space-y-1.5" aria-current={source === current || undefined}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">{title}</span>
            <span className={state.ready ? 'text-right text-emerald-700 dark:text-emerald-400' : 'text-right text-muted-foreground'}>{state.status}</span>
          </div>
          <p className="text-muted-foreground">{t(DESCRIPTION[source])}</p>
          <div className="flex flex-wrap gap-1">
            {state.ready && <Button size="sm" className="h-7" aria-label={t('assistant.pickDiscussLabel', { source: title })} onClick={() => onAttach(source)}>
              <MessageSquare className="h-3 w-3 mr-1" />{t('assistant.pickDiscuss')}
            </Button>}
            {source === 'clash' && (state.run || state.running) && <Button size="sm" className="h-7"
              disabled={!state.run} onClick={() => void runClash()}>
              {!state.running ? <Play className="h-3 w-3 mr-1" /> : <Spinner size="xs" className="mr-1" />}{t('assistant.pickRunClash')}
            </Button>}
            <Button size="sm" variant="ghost" className="h-7" aria-label={t('assistant.pickOpenLabel', { source: title })} onClick={() => panels.openInHome(source)}>
              <ArrowUpRight className="h-3 w-3 mr-1" />{t('assistant.pickOpen')}
            </Button>
          </div>
        </li>;
      })}
    </ul>
    {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
  </div>;
}
