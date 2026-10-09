/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The native gates of an IDS draft (#6915, kept for the IDS agent): native
 * audit, a dry run on the loaded models, then save into the native IDS
 * library or export the `.ids`. Statements the agent could not express stay
 * listed and travel inside the saved IDS (document description).
 */

import { useEffect, useRef, useState } from 'react';
import { Download, Play, Save, Square } from 'lucide-react';
import type { IDSAuditIssue } from '@ifc-lite/ids';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { auditIdsDraft, type IdsDraft } from '@/lib/check-authoring/ids-draft';
import { dryRunIds, isDryRunCurrent, type DryRun } from '@/lib/check-authoring/dry-run';
import { auditBlocks, exportIdsDraft, openDefinition, saveIdsDraft, type SavedDefinition } from '@/lib/check-authoring/save';
import { DryRunResults } from './DryRunResults';
import { Notice, UnsupportedList } from './DraftParts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function AuditSummary({ issues, failure }: { issues: IDSAuditIssue[] | null; failure: string | null }) {
  const { t } = useTranslation();
  // A rejected audit is not a clean one: it keeps saving and export blocked (issues stay null).
  if (failure) return <p className="font-medium text-destructive break-words">{t('checkAuthoring.auditFailed', { reason: failure })}</p>;
  if (!issues) return <p className="text-muted-foreground">{t('checkAuthoring.auditRunning')}</p>;
  const errors = issues.filter(issue => issue.severity === 'error'), warnings = issues.length - errors.length;
  return <div className="space-y-0.5">
    <p className={errors.length ? 'font-medium text-destructive' : 'text-muted-foreground'}>{t('checkAuthoring.auditSummary', { errors: errors.length, warnings })}</p>
    {issues.length > 0 && <ul aria-label={t('checkAuthoring.auditIssues')} className="pl-2 space-y-0.5">
      {issues.slice(0, 12).map((issue, index) => <li key={index} className={issue.severity === 'error' ? 'text-destructive break-words' : 'text-muted-foreground break-words'}>
        {t('checkAuthoring.auditIssue', { path: issue.path, message: issue.message })}</li>)}
    </ul>}
  </div>;
}

/** `audit` is the native IDS audit; replaceable only so a test can make it fail. */
export function IdsDraftChecks({ draft, audit = auditIdsDraft }: { draft: IdsDraft; audit?: (draft: IdsDraft) => Promise<IDSAuditIssue[]> }) {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const [issues, setIssues] = useState<IDSAuditIssue[] | null>(null);
  const [auditFailure, setAuditFailure] = useState<string | null>(null);
  const [run, setRun] = useState<DryRun | null>(null);
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState<SavedDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // Re-render on model and edit changes so the dry run's currency is always live.
  useViewerStore(s => s.models); useViewerStore(s => s.mutationVersion); useViewerStore(s => s.geometryContentVersion);
  useEffect(() => {
    let live = true;
    setIssues(null); setAuditFailure(null);
    audit(draft).then(result => { if (live) setIssues(result); },
      (failure: unknown) => { if (live) setAuditFailure(message(failure)); });
    return () => { live = false; };
  }, [draft, audit]);
  useEffect(() => () => abort.current?.abort(), []);
  const current = isDryRunCurrent(run, draft.document);
  const empty = draft.document.specifications.length === 0;
  const dryRun = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true); setError(null);
    try { const result = await dryRunIds(draft.document, controller.signal); if (!controller.signal.aborted) setRun(result); }
    catch (failure) { if (!controller.signal.aborted) setError(message(failure)); }
    finally { if (abort.current === controller) abort.current = null; setRunning(false); }
  };
  const save = () => {
    try { setSaved(saveIdsDraft(draft, issues, run)); setError(null); }
    catch (failure) { setError(message(failure)); }
  };
  const exportIds = () => {
    try { exportIdsDraft(draft, issues); }
    catch (failure) { setError(message(failure)); }
  };
  return <div className="space-y-2">
    {!empty && <AuditSummary issues={issues} failure={auditFailure} />}
    <UnsupportedList items={draft.unsupported} />
    {run && <DryRunResults run={run} current={current} />}
    {!saved && <div className="flex flex-wrap gap-1">
      {running
        ? <Button size="sm" variant="outline" className="h-7" onClick={() => { abort.current?.abort(); }}><Square className="h-3 w-3 mr-1" />{t('checkAuthoring.cancelDryRun')}</Button>
        : <Button size="sm" variant="outline" className="h-7" disabled={empty} onClick={() => void dryRun()}>
          <Play className="h-3 w-3 mr-1" />{t('checkAuthoring.dryRun')}</Button>}
      <Button size="sm" className="h-7" disabled={!current || auditBlocks(issues) || running} onClick={save}>
        <Save className="h-3 w-3 mr-1" />{t('checkAuthoring.saveIds')}</Button>
      <Button size="sm" variant="outline" className="h-7" disabled={!draft.xml || auditBlocks(issues)} onClick={exportIds}>
        <Download className="h-3 w-3 mr-1" />{t('checkAuthoring.exportIds')}</Button>
    </div>}
    {!saved && !empty && !current && <p className="text-muted-foreground">{t('checkAuthoring.saveNeedsDryRun')}</p>}
    {saved && <Notice tone="success">
      <p>{t('checkAuthoring.idsSaved')}</p>
      {saved.warning && <p>{saved.warning}</p>}
      <Button size="sm" variant="outline" className="h-7" onClick={() => { openDefinition('ids', saved.id); panels.openInHome('validation'); }}>
        {t('checkAuthoring.openIds')}</Button>
    </Notice>}
    {error && <Notice tone="error">{error}</Notice>}
  </div>;
}
