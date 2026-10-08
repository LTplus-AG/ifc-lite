/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import type { Clash } from '@ifc-lite/clash';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useClashGroupLibrary } from '@/lib/clash/group-workspace';
import { clashGroupApplicationLibrary, useClashGroupApplications, type ClashGroupApplication } from '@/lib/clash/group-applications';
import { undoClashGroupApplication } from '@/lib/clash/group-apply';
import { useClashApplicationFocus } from '@/lib/panels/evidence-focus';
import { applicationContinuity } from '@/lib/clash/group-continuity';

const LIST_LIMIT = 20;

function pairLabel(clash: Clash, t: ReturnType<typeof useTranslation>['t']): string {
  return t('clashApply.findingPair', { a: clash.a.name || clash.a.tag || clash.a.key, b: clash.b.name || clash.b.tag || clash.b.key });
}

/** How the applied groups resolve in the current native run: gone, re-identified and new stay visible. */
function Continuity({ receipt }: { receipt: ClashGroupApplication }) {
  const { t } = useTranslation();
  const clashes = useViewerStore(state => state.clashResult?.clashes);
  const workspace = useClashGroupLibrary(state => state.entries.find(entry => entry.id === receipt.workspaceId));
  const report = useMemo(() => clashes && workspace ? applicationContinuity(receipt, workspace.groups, clashes) : null,
    [receipt, workspace, clashes]);
  if (!clashes) return <p className="text-muted-foreground">{t('clashApply.continuityNoRun')}</p>;
  if (!report) return null;
  const reidentified = report.groups.flatMap(group => group.reidentified);
  return <section aria-label={t('clashApply.continuityTitle')} className="space-y-1 border-t border-border pt-1">
    <h5 className="font-medium">{t('clashApply.continuityTitle')}</h5>
    {report.unchanged ? <p>{t('clashApply.continuityUnchanged')}</p> : <>
      <ul>{report.groups.map(group => <li key={group.id}>{t('clashApply.continuityGroup', { name: group.name,
        unchanged: group.unchanged.length, reidentified: group.reidentified.length, gone: group.gone.length })}</li>)}</ul>
      {report.newFindings === null ? <p>{t('clashApply.continuityNewUnknown')}</p>
        : report.newFindings.length > 0 && <p>{t('clashApply.continuityNew', { count: report.newFindings.length })}</p>}
      {reidentified.length > 0 && <details><summary className="cursor-pointer">{t('clashApply.reidentifiedList')}</summary>
        <ul className="pl-3">{reidentified.slice(0, LIST_LIMIT).map(clash => <li key={clash.id}>{pairLabel(clash, t)}</li>)}</ul></details>}
      {report.newFindings && report.newFindings.length > 0 && <details><summary className="cursor-pointer">{t('clashApply.newList')}</summary>
        <ul className="pl-3">{report.newFindings.slice(0, LIST_LIMIT).map(clash => <li key={clash.id}>{pairLabel(clash, t)}</li>)}</ul></details>}
      <p className="text-muted-foreground">{t('clashApply.continuityNotes')}</p>
    </>}
    {report.missingGroups > 0 && <p className="text-muted-foreground">{t('clashApply.continuityMissing', { count: report.missingGroups })}</p>}
  </section>;
}

/** One durable apply receipt with undo; the stored entry wins over the copy the caller holds. */
export function ClashGroupApplicationCard({ receipt }: { receipt: ClashGroupApplication }) {
  const { t } = useTranslation();
  const live = useClashGroupApplications(state => state.entries.find(entry => entry.id === receipt.id)) ?? receipt;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const findings = live.after.groups.filter(group => live.addedGroupIds.includes(group.id)).reduce((sum, group) => sum + group.members.length, 0);
  const undo = async () => {
    setBusy(true);
    try {
      const outcome = await undoClashGroupApplication(live);
      setError(outcome.ok ? null : t(`clashApply.undoRefused.${outcome.reason}`));
    } finally { setBusy(false); }
  };
  const focus = useClashApplicationFocus(s => s.record);
  const focused = focus?.applicationId === live.id;
  const original = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) { original.current?.focus(); original.current?.scrollIntoView?.({ block: 'nearest' }); }
  }, [focused, focus]);
  const undone = live.status === 'undone';
  return <div ref={original} tabIndex={focused ? -1 : undefined} aria-current={focused ? true : undefined} aria-live="polite" className={cn('rounded border p-2 space-y-1.5', undone ? 'border-border bg-muted/40' : 'border-emerald-500/40 bg-emerald-500/10')}>
    <p className="font-medium">{undone
      ? t(live.created ? 'clashApply.receiptUndoneCreated' : 'clashApply.receiptUndone', { workspace: live.workspaceName })
      : t('clashApply.receiptApplied', { groups: live.addedGroupIds.length, findings, workspace: live.workspaceName })}</p>
    {live.movedFindings > 0 && <p>{t('clashApply.receiptMoved', { count: live.movedFindings })}</p>}
    {live.partial && <p>{t('clashApply.receiptPartial')}</p>}
    {!undone && <Continuity receipt={live} />}
    {!undone && <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void undo()}>
      <Undo2 className="h-3 w-3 mr-1" />{t('clashApply.undo')}</Button>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}

/** Applied AI receipts for the active workspace, shown beside the native workspace picker. */
export function ClashGroupApplications() {
  const { t } = useTranslation();
  const activeId = useClashGroupLibrary(state => state.activeId);
  const entries = useClashGroupApplications(state => state.entries);
  const focus = useClashApplicationFocus(s => s.record);
  useEffect(() => { void clashGroupApplicationLibrary.initialize(); }, []);
  const receipts = useMemo(() => entries.filter(entry => entry.id === focus?.applicationId || (entry.workspaceId === activeId && entry.status === 'applied'))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [entries, activeId, focus]);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const hasOriginal = !!focus && receipts.some(receipt => receipt.id === focus.applicationId);
  // A new request must restore the browser's mutable disclosure before child focus effects run.
  useLayoutEffect(() => { if (hasOriginal && disclosure.current) disclosure.current.open = true; }, [focus, hasOriginal]);
  if (!receipts.length) return null;
  return <details ref={disclosure} className="px-2 py-1">
    <summary className="cursor-pointer font-medium">{t('clashApply.applicationsTitle', { count: receipts.length })}</summary>
    <div className="mt-1 max-h-64 space-y-2 overflow-y-auto">{receipts.map(receipt => <ClashGroupApplicationCard key={receipt.id} receipt={receipt} />)}</div>
  </details>;
}
