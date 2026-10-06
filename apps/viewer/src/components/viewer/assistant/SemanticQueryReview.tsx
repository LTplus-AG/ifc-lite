/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useSemanticSession } from '@/lib/semantic/session';
import { lintSemanticQuery, type SemanticQueryProposal } from '@/lib/semantic/assist/query-proposal';
import { discloseGrant, useSemanticEndpointGrant, type EndpointGrant } from '@/lib/semantic/assist/endpoint-grant';
import { runReviewedQuery, type QueryRun } from '@/lib/semantic/assist/query-run';
import { revisionPinIsCurrent } from '@/lib/semantic/assist/revision-pin';
import { SemanticResults } from '../SemanticResults';
import { ReviewFrame } from './SemanticReviewParts';

/** Lint, disclose the grant, and run only on an explicit click; results carry the revision they were resolved against. */
export function SemanticQueryReview({ proposal }: { proposal: SemanticQueryProposal }) {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const lint = useMemo(() => lintSemanticQuery(proposal), [proposal]);
  const grant = useSemanticEndpointGrant(s => s.grant);
  const revisions = useSemanticSession(s => s.revisions);
  const models = useViewerStore(s => s.models);
  const [run, setRun] = useState<QueryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ controller: AbortController; grant: EndpointGrant } | null>(null);
  const [running, setRunning] = useState(false);
  // A revoked or replaced grant aborts a pending run, as in the Linked records panel.
  useEffect(() => { if (pending.current && pending.current.grant !== grant) pending.current.controller.abort(); }, [grant]);
  useEffect(() => () => pending.current?.controller.abort(), []);
  const current = run ? revisionPinIsCurrent(run.pin, revisions, models) : false;
  const execute = async () => {
    if (!grant || !lint.ok || pending.current) return;
    const controller = new AbortController();
    pending.current = { controller, grant };
    setRunning(true); setError(null);
    try {
      const result = await runReviewedQuery(proposal, grant, controller.signal);
      if (!controller.signal.aborted) setRun(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      else setError(t('semanticAssist.queryCancelled'));
    } finally {
      if (pending.current?.controller === controller) pending.current = null;
      setRunning(false);
    }
  };
  const disclosure = grant ? discloseGrant(grant) : null;
  return <ReviewFrame label={t('semanticAssist.queryTitle')} title={proposal.title}>
    <p className="text-muted-foreground break-words">{proposal.purpose}</p>
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-1.5 font-mono text-2xs">{proposal.query}</pre>
    <p className="text-muted-foreground">{proposal.expected.form === 'select'
      ? t('semanticAssist.queryExpectedSelect', { columns: proposal.expected.columns.join(', ') }) : t('semanticAssist.queryExpectedConstruct')}</p>
    {lint.ok ? <p className="text-emerald-700 dark:text-emerald-400">{t('semanticAssist.queryLintOk', { form: lint.form.toUpperCase(), limit: lint.limit })}</p>
      : <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
        <p>{t('semanticAssist.queryLintRefused')}</p><ul className="list-disc pl-4">{lint.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
      </div>}
    {disclosure ? <dl aria-label={t('semanticAssist.grantTitle')} className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 rounded border border-border p-1.5">
      <dt className="text-muted-foreground">{t('semanticAssist.grantEndpoint')}</dt><dd className="break-all font-mono text-2xs">{disclosure.endpoint}</dd>
      <dt className="text-muted-foreground">{t('semanticAssist.grantHost')}</dt><dd className="break-all font-mono text-2xs">{disclosure.host}</dd>
      <dt className="text-muted-foreground">{t('semanticAssist.grantLoopback')}</dt><dd>{t(disclosure.loopback ? 'semanticAssist.yes' : 'semanticAssist.no')}</dd>
      {disclosure.relay && <><dt className="text-muted-foreground">{t('semanticAssist.grantRelay')}</dt><dd className="font-mono text-2xs">{disclosure.relay}</dd></>}
      <dt className="text-muted-foreground">{t('semanticAssist.grantCredential')}</dt><dd>{t(disclosure.credential ? 'semanticAssist.credentialHidden' : 'semanticAssist.credentialNone')}</dd>
    </dl> : <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1">
      <p>{t('semanticAssist.grantMissing')}</p>
      <Button size="sm" variant="outline" className="h-7" onClick={() => panels.openInHome('semantic')}><ArrowUpRight className="h-3 w-3 mr-1" />{t('semanticAssist.openLinkedRecords')}</Button>
    </div>}
    <div className="flex flex-wrap gap-1">
      <Button size="sm" className="h-7" disabled={!lint.ok || !grant || running} onClick={() => void execute()}><Play className="h-3 w-3 mr-1" />{t('semanticAssist.queryRun')}</Button>
      {running && <Button size="sm" variant="outline" className="h-7" onClick={() => pending.current?.controller.abort()}><Square className="h-3 w-3 mr-1" />{t('semanticAssist.cancel')}</Button>}
    </div>
    {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive break-words">{error}</p>}
    {run && <div aria-live="polite" className="space-y-1 overflow-x-auto">
      <p className="text-muted-foreground break-all">{t('semanticAssist.queryRan', { source: run.source, time: run.retrievedAt })}</p>
      {run.result.form === 'construct' ? <>
        <p>{t('semanticAssist.queryStatements', { count: run.result.quadCount })}</p>
        <details><summary className="cursor-pointer text-muted-foreground">{t('semanticAssist.queryGraph')}</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{run.result.value.slice(0, 20_000)}</pre></details>
      </> : current ? <SemanticResults results={run.result.value} mapping={proposal.mapping} revisions={revisions} onError={failure => setError(String(failure))} />
        : <HistoricalRows statuses={run.result.statuses} capturedAt={run.pin.capturedAt} />}
    </div>}
  </ReviewFrame>;
}

function HistoricalRows({ statuses, capturedAt }: { statuses: readonly string[]; capturedAt: string }) {
  const { t } = useTranslation();
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return <div className="rounded bg-muted p-2 space-y-1">
    <p className="font-medium">{t('semanticAssist.historical')}</p>
    <p className="text-muted-foreground">{t('semanticAssist.queryHistorical', { time: capturedAt, count: statuses.length })}</p>
    <ul>{[...counts].map(([status, count]) => <li key={status}>{status}: {count}</li>)}</ul>
  </div>;
}
