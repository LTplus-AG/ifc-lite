/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ListChecks, Square } from 'lucide-react';
import type { ClashResult } from '@ifc-lite/clash';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { resolveStreamRoute } from '@/lib/llm/byok-guard';
import { modelCapabilities } from '@/lib/llm/model-capabilities';
import { UNCONFIGURED_MODEL_ID } from '@/lib/llm/models';
import type { RootBudgetLimits } from '@ifc-lite/ai';
import { createRootBudget } from '@/lib/llm/root-budget';
import { getApiKeys } from '@/services/api-keys';
import { CLASSIFY_ROOT_BUDGET, estimateClassification, planClassification } from '@/lib/assistant/clash-classify-chunks';
import { runClassification, type ChunkResult, type ClassifyRunResult } from '@/lib/assistant/clash-classify-run';

const DONE = new Set<ChunkResult['status']>(['accepted', 'adjusted', 'invalid', 'failed', 'cancelled', 'not-run']);

/**
 * Classify every native finding, not only the discussion sample: bounded
 * chunks under one root budget with an estimate shown before starting,
 * progress, cancellation and a result that accounts for every finding.
 */
export function ClashClassifyAll({ result, enabled, onResult, limits = CLASSIFY_ROOT_BUDGET }: {
  result: ClashResult;
  enabled: boolean;
  onResult: (run: ClassifyRunResult) => void;
  limits?: RootBudgetLimits;
}) {
  const { t } = useTranslation();
  const model = useViewerStore(state => state.chatActiveModel);
  const [consent, setConsent] = useState(false);
  const [controller, setController] = useState<AbortController | null>(null);
  const [chunks, setChunks] = useState<readonly ChunkResult[]>([]);
  const [run, setRun] = useState<ClassifyRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = useMemo(() => planClassification(result.clashes), [result]);
  // Closing the review mid-run (stale evidence, another conversation) aborts the run: no budget is spent without visible progress.
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  const estimate = estimateClassification(plan, limits, modelCapabilities(model).maxOutputTokens);
  const start = async () => {
    if (model === UNCONFIGURED_MODEL_ID) { setError(t('clashClassify.missingModel')); return; }
    const route = resolveStreamRoute(model, getApiKeys());
    if (route.kind === 'missing-key') { setError(t('clashClassify.missingKey')); return; }
    if (!estimate.fits) return;
    const abort = new AbortController();
    active.current = abort;
    setController(abort); setError(null); setRun(null); setChunks([]);
    try {
      const outcome = await runClassification({ plan, route, proxyUrl: import.meta.env.VITE_LLM_PROXY_URL || '/api/chat',
        budget: createRootBudget(limits), signal: abort.signal, allowNormalization: consent,
        isCurrent: () => useViewerStore.getState().clashResult === result, onProgress: chunks => { if (active.current === abort) setChunks(chunks); } });
      if (active.current !== abort) return;
      setRun(outcome); setChunks(outcome.chunks);
      onResult(outcome);
    } finally {
      if (active.current === abort) { active.current = null; setController(null); }
    }
  };
  const done = chunks.filter(chunk => DONE.has(chunk.status)).length;
  const running = controller !== null;
  return <section aria-label={t('clashClassify.title')} className="rounded border border-border p-2 space-y-1.5">
    <h4 className="flex items-center gap-1.5 font-semibold"><ListChecks className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('clashClassify.title')}</h4>
    <p className="text-muted-foreground">{t('clashClassify.hint')}</p>
    {plan.chunks.length === 0 ? <p>{t('clashClassify.noFindings')}</p> : <p>{t('clashClassify.estimate', {
      findings: plan.clashes.length, chunks: estimate.chunks, tokens: estimate.outputTokens.toLocaleString(),
      maxRequests: limits.maxRequests, maxTokens: limits.maxOutputTokens.toLocaleString() })}</p>}
    {plan.chunks.length > 0 && !estimate.fits && <p role="alert" className="text-amber-700 dark:text-amber-400">{t('clashClassify.overBudget')}</p>}
    <label className="flex items-start gap-1.5">
      <input type="checkbox" className="mt-0.5" checked={consent} disabled={running} onChange={event => setConsent(event.target.checked)} />
      {t('clashClassify.consent')}
    </label>
    {running ? <Button size="sm" variant="outline" className="h-7" onClick={() => controller.abort()}>
      <Square className="h-3 w-3 mr-1" />{t('clashClassify.cancel')}</Button>
      : <Button size="sm" className="h-7" disabled={!enabled || !estimate.fits} onClick={() => void start()}>{t('clashClassify.start')}</Button>}
    {chunks.length > 0 && <div className="space-y-1">
      <progress aria-label={t('clashClassify.progressLabel')} max={chunks.length} value={done} className="h-1.5 w-full accent-primary" />
      <p aria-live="polite">{t('clashClassify.progress', { done, total: chunks.length })}</p>
      <details><summary className="cursor-pointer text-muted-foreground">{t('clashClassify.progressLabel')}</summary>
        <ul className="pl-3">{chunks.map(chunk => <li key={chunk.index}>{t('clashClassify.chunkRow', { index: chunk.index + 1, count: chunk.rows,
          status: t(`clashClassify.status.${chunk.status}`) })}
          {chunk.reason && <span className="ml-1 break-words text-muted-foreground">{chunk.reason}</span>}</li>)}</ul>
      </details>
    </div>}
    {run && <div aria-live="polite" className="space-y-1">
      {run.stale && <p role="alert" className="text-amber-700 dark:text-amber-400">{t('clashClassify.stale')}</p>}
      {run.partial && <p>{t('clashClassify.partial', { failed: run.accounting.failed, notRun: run.accounting.notRun })}</p>}
      {run.chunks.filter(chunk => chunk.adjustments).map(chunk => <p key={chunk.index} role="note">{t('clashClassify.adjusted', {
        index: chunk.index + 1, repeats: chunk.adjustments!.repeats, unknown: chunk.adjustments!.unknown, groups: chunk.adjustments!.groups })}</p>)}
      {run.merged.some(group => group.chunks.length > 1) && <p>{t('clashClassify.merged', { count: run.merged.filter(group => group.chunks.length > 1).length })}</p>}
    </div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </section>;
}
