/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Visible notes for everything a bound component could otherwise hide: refs to
 * models that are not loaded (inert, not silently empty), query problems, and
 * results cut at the query limit. Also the Callout component, whose tones the
 * notes reuse.
 */

import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { createComponentImplementation } from '@a2ui/react';
import { CalloutApi } from '@ifc-lite/a2ui/catalog';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { QueryProblem } from '@ifc-lite/a2ui';
import type { QueryResult } from '@/lib/a2ui/query-eval';
import { SafeMarkdown, weightStyle } from './basic-layout';
import { useA2uiRuntime } from './runtime';

export type Tone = 'neutral' | 'info' | 'success' | 'warn' | 'error';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-border bg-muted/40',
  info: 'border-info-border bg-info-surface',
  success: 'border-ok-border bg-ok-surface',
  warn: 'border-warn-border bg-warn-surface',
  error: 'border-danger-border bg-danger-surface',
};

const TONE_ICON: Record<Tone, ReactNode> = {
  neutral: <Info className="h-4 w-4 text-muted-foreground" aria-hidden />,
  info: <Info className="h-4 w-4 text-info" aria-hidden />,
  success: <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />,
  warn: <AlertTriangle className="h-4 w-4 text-warn" aria-hidden />,
  error: <XCircle className="h-4 w-4 text-danger" aria-hidden />,
};

export function toneClass(tone: unknown): string {
  return TONE_CLASS[(tone as Tone) in TONE_CLASS ? (tone as Tone) : 'neutral'];
}

export function Note({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div role={tone === 'error' || tone === 'warn' ? 'alert' : 'note'} className={cn('flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs', TONE_CLASS[tone])}>
      <span className="mt-px shrink-0">{TONE_ICON[tone]}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Notes for a query result and for refs whose model is not loaded. */
export function ResultNotes({ result, unloadedModels = [], problems = [], shown }: { result?: QueryResult | null; unloadedModels?: string[]; problems?: QueryProblem[]; shown?: number }) {
  const { t } = useTranslation();
  const { host } = useA2uiRuntime();
  const unloaded = [...new Set([...unloadedModels, ...(result?.unloadedModel ? [result.unloadedModel] : [])])];
  const visible = shown ?? result?.rows.length ?? 0;
  return (
    <>
      {unloaded.map((model) => (
        <Note key={`m:${model}`} tone="warn">{t('a2ui.unloadedModel', { model: host.modelName(model) ?? model })}</Note>
      ))}
      {[...problems, ...(result?.problems ?? [])].map((p, i) => (
        <Note key={`p:${i}`} tone="warn">{t('a2ui.queryProblem', { path: p.path || 'query', message: p.message })}</Note>
      ))}
      {result && result.total > visible && visible > 0 && (
        <Note>{t('a2ui.truncated', { shown: visible.toLocaleString(), total: result.total.toLocaleString() })}</Note>
      )}
    </>
  );
}

export const CalloutImpl = createComponentImplementation(CalloutApi, ({ props }) => {
  const tone: Tone = props.tone ?? 'neutral';
  return (
    <div style={weightStyle(props.weight)} role={tone === 'error' || tone === 'warn' ? 'alert' : 'note'} className={cn('flex items-start gap-2 rounded-md border p-2.5', TONE_CLASS[tone])}>
      <span className="mt-0.5 shrink-0">{TONE_ICON[tone]}</span>
      <div className="min-w-0">
        {typeof props.title === 'string' && props.title && <div className="text-sm font-semibold">{props.title}</div>}
        <SafeMarkdown text={String(props.text ?? '')} />
      </div>
    </div>
  );
});
