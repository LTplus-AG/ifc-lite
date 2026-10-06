/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import type { Clash } from '@ifc-lite/clash';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import type { ClashGroupDraft } from '@/lib/assistant/clash-group-draft';
import { DEFAULT_GROUP_WORKSPACE, useClashGroupLibrary } from '@/lib/clash/group-workspace';
import type { ClashGroupApplication } from '@/lib/clash/group-applications';
import {
  applyClashGroupPlan, newWorkspaceBase, planClashGroupApply, readApplyBase,
  type ClashGroupApplyPlan, type PlanRefusal,
} from '@/lib/clash/group-apply';

const field = 'h-7 min-w-0 rounded border border-input bg-background px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type PlanState = { ok: true; plan: ClashGroupApplyPlan } | { ok: false; reason: PlanRefusal } | null;

/**
 * Choose the target workspace, see exactly what the partition becomes and
 * apply. The default is a new named workspace, so human groups are never
 * overwritten silently; an existing workspace needs explicit confirmation for
 * every finding that leaves one of its groups.
 */
export function ClashGroupApply({ draft, clashes, enabled, origin, onApplied }: {
  draft: ClashGroupDraft;
  clashes: readonly Clash[] | undefined;
  /** False while the review is stale or the run changed. */
  enabled: boolean;
  origin: string;
  onApplied: (receipt: ClashGroupApplication) => void;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<'new' | 'active'>('new');
  const [name, setName] = useState(() => t('clashApply.defaultName', { date: stamp(new Date()) }));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const library = useClashGroupLibrary();
  const active = library.entries.find(entry => entry.id === library.activeId);
  const activeName = active?.name ?? t('clashGroups.defaultWorkspace');
  const groups = useMemo(() => draft.groups.map(group => ({ name: group.name, members: group.members })), [draft]);
  const [plan, setPlan] = useState<PlanState>(null);
  useEffect(() => {
    if (!clashes) { setPlan(null); return; }
    if (target === 'new') { setPlan(planClashGroupApply(groups, newWorkspaceBase(name), clashes)); return; }
    let current = true;
    void readApplyBase(library.activeId, library.activeId === DEFAULT_GROUP_WORKSPACE ? t('clashGroups.defaultWorkspace') : activeName)
      .then(base => { if (current) setPlan(base ? planClashGroupApply(groups, base, clashes) : { ok: false, reason: 'workspace-unavailable' }); });
    return () => { current = false; };
    // Re-plan whenever the target workspace's stored content may have moved.
  }, [groups, clashes, target, name, library.activeId, library.entries, activeName, reload, t]);
  useEffect(() => setConfirmed(false), [plan]);
  const ready = plan?.ok ? plan.plan : null;
  const apply = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const outcome = await applyClashGroupPlan(ready, { confirmMoves: confirmed, origin, source: draft.origin.kind,
        partial: draft.origin.kind === 'full-run' && draft.origin.partial });
      if (outcome.ok) { setError(null); onApplied(outcome.receipt); return; }
      setError(t(`clashApply.refused.${outcome.reason}`));
      if (outcome.reason === 'workspace-changed') setReload(value => value + 1);
    } finally { setBusy(false); }
  };
  return <section aria-label={t('clashApply.title')} className="rounded border border-border p-2 space-y-1.5">
    <h4 className="font-semibold">{t('clashApply.title')}</h4>
    <fieldset className="space-y-1">
      <legend className="sr-only">{t('clashApply.target')}</legend>
      <label className="flex items-center gap-1.5">
        <input type="radio" name="clash-apply-target" checked={target === 'new'} onChange={() => setTarget('new')} />
        {t('clashApply.targetNew')}
      </label>
      {target === 'new' && <input aria-label={t('clashApply.workspaceName')} className={`${field} w-full`} maxLength={200} value={name}
        onChange={event => setName(event.target.value)} />}
      <label className="flex items-center gap-1.5">
        <input type="radio" name="clash-apply-target" checked={target === 'active'} onChange={() => setTarget('active')} />
        {t('clashApply.targetActive', { name: activeName })}
      </label>
    </fieldset>
    {plan && !plan.ok && <p role="alert" className="text-amber-700 dark:text-amber-400">{t(`clashApply.planRefused.${plan.reason}`)}</p>}
    {ready && <div aria-live="polite" className="space-y-1">
      <p>{t('clashApply.planAdded', { groups: ready.added.length, findings: ready.added.reduce((sum, group) => sum + group.count, 0) })}</p>
      {!ready.base.created && <p>{t('clashApply.planKept', { count: ready.keptGroups })}</p>}
      {ready.movedFindings > 0 && <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1">
        <p>{t('clashApply.planMoved', { count: ready.movedFindings })}</p>
        <ul className="pl-3">{ready.moved.map(entry => <li key={`${entry.from}\u0000${entry.to}`}>{t('clashApply.planMovedRow', entry)}</li>)}</ul>
        {ready.removedGroups.length > 0 && <p>{t('clashApply.planRemoved', { names: ready.removedGroups.join(', ') })}</p>}
        <label className="flex items-center gap-1.5 font-medium">
          <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
          {t('clashApply.confirmMoves', { count: ready.movedFindings })}
        </label>
      </div>}
    </div>}
    {draft.origin.kind === 'full-run' && draft.origin.partial && <p className="text-muted-foreground">{t('clashApply.partialNote')}</p>}
    <Button size="sm" className="h-7" disabled={!enabled || !ready || busy || (ready.movedFindings > 0 && !confirmed)} onClick={() => void apply()}>
      <Check className="h-3 w-3 mr-1" />{t(busy ? 'clashApply.applying' : 'clashApply.apply')}
    </Button>
    {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
  </section>;
}
