/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { usePanelControls } from '@/hooks/usePanelControls';
import { openAssistant, useAssistantPlacement } from '@/lib/assistant/placement';
import { preflightOpenFlow, type FlowPreflightResult } from '@/lib/assistant/flow-preflight';

/** Native preflight of the open graph; Run stays the Flow panel's explicit action. */
export function FlowPreflight() {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const graph = useViewerStore(s => s.flowDoc);
  const [result, setResult] = useState<FlowPreflightResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!graph) return null;
  const check = async () => {
    setChecking(true); setError(null);
    try { setResult(await preflightOpenFlow()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setChecking(false); }
  };
  const current = result?.graph === graph;
  return <div className="space-y-1.5">
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="outline" className="h-7" disabled={checking} onClick={() => void check()}>
        <ShieldCheck className="h-3 w-3 mr-1" aria-hidden="true" />{checking ? t('flowAssistant.preflightRunning') : t('flowAssistant.preflight')}
      </Button>
      <Button size="sm" variant="ghost" className="h-7" onClick={() => panels.openInHome('flow')}>
        <ArrowUpRight className="h-3 w-3 mr-1" aria-hidden="true" />{t('flowAssistant.openFlowToRun')}
      </Button>
    </div>
    {result && !current && <p className="text-muted-foreground">{t('flowAssistant.preflightStale')}</p>}
    {result && current && (result.ok
      ? <p aria-live="polite" className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2">{t('flowAssistant.preflightOk', { name: graph.name })}</p>
      : <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 space-y-1">
        <p>{t('flowAssistant.preflightFailed')}</p>
        <ul className="list-disc pl-4">{result.problems.map((problem, index) => <li key={index} className="break-words">{t(problem.labelKey, problem.params)}</li>)}</ul>
        {result.editDenial === 'edit-mode' && <Button size="sm" variant="outline" className="h-7" disabled={checking} onClick={() => {
          // Preserve the Assistant host: moving a split review into the primary slot remounts its local result.
          useViewerStore.getState().setEditEnabled(true);
          openAssistant(useAssistantPlacement.getState().returnTarget);
          void check();
        }}>{t('modelChanges.turnOnEditMode')}</Button>}
      </div>)}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
