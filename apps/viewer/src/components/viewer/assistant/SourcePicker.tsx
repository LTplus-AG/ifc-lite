/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useReducer, useState } from 'react';
import { ArrowUpRight, MessageSquare, Play } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { useClash } from '@/hooks/useClash';
import { usePanelControls } from '@/hooks/usePanelControls';
import { panelTitleKey, type WorkspacePanelId } from '@/lib/panels/registry';
import type { AssistantSource } from '@/lib/assistant/sources';
import { ADAPTER_GROUPS, ADAPTERS, UNSUPPORTED_PANELS } from '@/lib/assistant/adapters/registry';
import { sourceActionAvailability } from '@/lib/assistant/adapters/actions';
import type { SourceActionAvailability, AdapterReadiness } from '@/lib/assistant/adapters/types';

type SourceState = AdapterReadiness & { actions: SourceActionAvailability };

/** Live native status per source: what the assistant would see if attached now. */
function useReadiness(): ReadonlyMap<AssistantSource, SourceState> {
  // Sources whose native state lives outside the viewer store re-render the picker themselves;
  // the selector below re-reads every adapter on that render.
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const detach = ADAPTERS.flatMap(adapter => adapter.subscribe ? [adapter.subscribe(refresh)] : []);
    return () => { for (const off of detach) off(); };
  }, []);
  // One primitive signature keeps re-renders to actual status changes.
  const signature = useViewerStore(s => JSON.stringify(ADAPTERS.map(adapter => {
    const readiness = adapter.readiness(s);
    return { ...readiness, actions: sourceActionAvailability(adapter, s, readiness) };
  })));
  return useMemo(() => {
    const parsed = JSON.parse(signature) as SourceState[];
    return new Map(ADAPTERS.map((adapter, index) => [adapter.id, parsed[index]]));
  }, [signature]);
}

const BOUNDARIES = Object.entries(UNSUPPORTED_PANELS) as Array<[WorkspacePanelId, NonNullable<typeof UNSUPPORTED_PANELS[WorkspacePanelId]>]>;

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
      {onCancel && <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onCancel}>{t('assistant.cancel')}</Button>}
    </div>
    <p className="text-muted-foreground">{t('assistant.pickHint')}</p>
    {ADAPTER_GROUPS.map(group => {
      const adapters = ADAPTERS.filter(adapter => adapter.group === group.id);
      if (!adapters.length) return null;
      return <section key={group.id} aria-label={t(group.labelKey)} className="space-y-1.5">
        <h3 className="pt-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{t(group.labelKey)}</h3>
        <ul className="space-y-1.5">
          {adapters.map(adapter => {
            const source = adapter.id;
            const state = readiness.get(source);
            if (!state) return null;
            const title = t(adapter.titleKey);
            return <li key={source} data-source={source} className="rounded border border-border p-2 space-y-1.5" aria-current={source === current || undefined}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{title}</span>
                <span className={state.ready ? 'text-right text-emerald-700 dark:text-emerald-400' : 'text-right text-muted-foreground'}>
                  {t(state.status.labelKey, state.status.params)}
                </span>
              </div>
              <p className="text-muted-foreground">{t(adapter.descriptionKey)}</p>
              <div className="flex flex-wrap gap-1">
                {state.actions.discuss && <Button size="sm" className="h-7" aria-label={t('assistant.pickDiscussLabel', { source: title })} onClick={() => onAttach(source)}>
                  <MessageSquare className="h-3 w-3 mr-1" />{t('assistant.pickDiscuss')}
                </Button>}
                {adapter.actions.run.kind === 'native' && (!state.ready || state.running) && <Button size="sm" className="h-7"
                  disabled={!state.actions.run.available} title={state.actions.run.reasonKey ? t(state.actions.run.reasonKey) : undefined} onClick={() => void runClash()}>
                  {!state.running ? <Play className="h-3 w-3 mr-1" /> : <Spinner size="xs" className="mr-1" />}{t('assistant.pickRunClash')}
                </Button>}
                <Button size="sm" variant="ghost" className="h-7" aria-label={t('assistant.pickOpenLabel', { source: title })}
                  disabled={!state.actions.open} onClick={() => panels.openInHome(adapter.actions.open.panel)}>
                  <ArrowUpRight className="h-3 w-3 mr-1" />{t('assistant.pickOpen')}
                </Button>
              </div>
              {adapter.actions.run.kind === 'native' && !state.ready && state.actions.run.reasonKey && !state.running
                && <p className="text-muted-foreground">{t(state.actions.run.reasonKey)}</p>}
            </li>;
          })}
        </ul>
      </section>;
    })}
    <details className="rounded border border-dashed border-border p-2">
      <summary className="cursor-pointer font-semibold">{t('assistantSources.unsupportedTitle')}</summary>
      <p className="mt-1 text-muted-foreground">{t('assistantSources.unsupportedHint')}</p>
      <ul className="mt-1 space-y-1" aria-label={t('assistantSources.unsupportedTitle')}>
        {BOUNDARIES.map(([panel, reason]) => <li key={panel} data-boundary={panel}>
          <span className="font-semibold">{t(panelTitleKey(panel))}</span>{' '}
          <span className="text-muted-foreground">{t(reason)}</span>
        </li>)}
      </ul>
    </details>
    {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
  </div>;
}
