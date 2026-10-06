/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review of an `ids.specifications` draft (#6915): native audit, inline edits,
 * a dry run on the loaded models, then save into the native IDS library or
 * export the `.ids`. Unsupported requirements stay listed and travel inside
 * the saved IDS (document description and specification instructions).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCheck, Download, Play, Save, Square } from 'lucide-react';
import type { IDSAuditIssue } from '@ifc-lite/ids';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { auditIdsDraft, buildIdsDraft, type IdsDraft, type IdsProposal } from '@/lib/check-authoring/ids-proposal';
import { dryRunIds, isDryRunCurrent, type DryRun } from '@/lib/check-authoring/dry-run';
import { auditBlocks, exportIdsDraft, openDefinition, saveIdsDraft, type SavedDefinition } from '@/lib/check-authoring/save';
import { DryRunResults } from './DryRunResults';
import { IdsSpecificationEditor } from './IdsSpecificationEditor';
import { Notice, ReviewCard, TextField, UnsupportedList } from './DraftParts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function build(proposal: IdsProposal): { draft: IdsDraft | null; error: string | null } {
  if (!proposal.title.trim() || proposal.document.specifications.some(spec => !spec.name.trim())) return { draft: null, error: 'names' };
  try { return { draft: buildIdsDraft(proposal), error: null }; }
  catch (error) { return { draft: null, error: message(error) }; }
}

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
export function IdsDraftReview({ initial, audit = auditIdsDraft }: { initial: IdsProposal; audit?: (draft: IdsDraft) => Promise<IDSAuditIssue[]> }) {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const [proposal, setProposal] = useState(initial);
  const { draft, error: buildError } = useMemo(() => build(proposal), [proposal]);
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
    if (!draft) return;
    audit(draft).then(result => { if (live) setIssues(result); },
      (failure: unknown) => { if (live) setAuditFailure(message(failure)); });
    return () => { live = false; };
  }, [draft, audit]);
  useEffect(() => () => abort.current?.abort(), []);
  const current = !!draft && isDryRunCurrent(run, draft.document);
  const locked = saved !== null || running;
  const edit = (next: IdsProposal) => { setProposal(next); setError(null); };
  const dryRun = async () => {
    if (!draft) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true); setError(null);
    try { const result = await dryRunIds(draft.document, controller.signal); if (!controller.signal.aborted) setRun(result); }
    catch (failure) { if (!controller.signal.aborted) setError(message(failure)); }
    finally { if (abort.current === controller) abort.current = null; setRunning(false); }
  };
  const save = () => {
    if (!draft) return;
    try { setSaved(saveIdsDraft(draft, issues, run)); setError(null); }
    catch (failure) { setError(message(failure)); }
  };
  const exportIds = () => {
    if (!draft) return;
    try { exportIdsDraft(draft, issues); }
    catch (failure) { setError(message(failure)); }
  };
  const specs = proposal.document.specifications;
  return <ReviewCard label={t('checkAuthoring.idsTitle')} icon={<ClipboardCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}>
    <TextField id="ids-draft-title" label={t('checkAuthoring.draftTitle')} value={proposal.title} disabled={locked}
      onChange={title => edit({ ...proposal, title, document: { ...proposal.document, info: { ...proposal.document.info, title } } })} />
    {proposal.rationale && <p className="text-muted-foreground break-words">{proposal.rationale}</p>}
    {draft && specs.length > 0 && <AuditSummary issues={issues} failure={auditFailure} />}
    {buildError && <Notice tone="error">{buildError === 'names' ? t('checkAuthoring.namesRequired') : buildError}</Notice>}
    {specs.length > 0 && <ul aria-label={t('checkAuthoring.specifications')} className="space-y-1.5">
      {specs.map((spec, index) => <IdsSpecificationEditor key={index} spec={spec} index={index} units={proposal.units} disabled={locked}
        onChange={next => edit({ ...proposal, document: { ...proposal.document, specifications: specs.map((item, i) => i === index ? next : item) } })} />)}
    </ul>}
    <UnsupportedList items={proposal.unsupported} />
    {run && <DryRunResults run={run} current={current} />}
    {!saved && <div className="flex flex-wrap gap-1">
      {running
        ? <Button size="sm" variant="outline" className="h-7" onClick={() => { abort.current?.abort(); }}><Square className="h-3 w-3 mr-1" />{t('checkAuthoring.cancelDryRun')}</Button>
        : <Button size="sm" variant="outline" className="h-7" disabled={!draft || !specs.length} onClick={() => void dryRun()}>
          <Play className="h-3 w-3 mr-1" />{t('checkAuthoring.dryRun')}</Button>}
      <Button size="sm" className="h-7" disabled={!draft || !current || auditBlocks(issues) || running} onClick={save}>
        <Save className="h-3 w-3 mr-1" />{t('checkAuthoring.saveIds')}</Button>
      <Button size="sm" variant="outline" className="h-7" disabled={!draft?.xml || auditBlocks(issues)} onClick={exportIds}>
        <Download className="h-3 w-3 mr-1" />{t('checkAuthoring.exportIds')}</Button>
    </div>}
    {!saved && draft && !current && <p className="text-muted-foreground">{t('checkAuthoring.saveNeedsDryRun')}</p>}
    {saved && <Notice tone="success">
      <p>{t('checkAuthoring.idsSaved')}</p>
      {saved.warning && <p>{saved.warning}</p>}
      <Button size="sm" variant="outline" className="h-7" onClick={() => { openDefinition('ids', saved.id); panels.openInHome('validation'); }}>
        {t('checkAuthoring.openIds')}</Button>
    </Notice>}
    {error && <Notice tone="error">{error}</Notice>}
  </ReviewCard>;
}
