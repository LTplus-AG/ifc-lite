/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { Crosshair, Pencil } from 'lucide-react';
import type { Clash } from '@ifc-lite/clash';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import {
  draftAccounting, draftUnclassified, mergeDraftGroups, moveDraftFindings, renameDraftGroup,
  type ClashGroupDraft, type DraftEdit, type DraftFinding, type DraftGroup,
} from '@/lib/assistant/clash-group-draft';

const field = 'h-7 min-w-0 rounded border border-input bg-background px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

interface EditorProps {
  draft: ClashGroupDraft;
  onChange: (draft: ClashGroupDraft) => void;
  /** The live native finding for an occurrence; undefined when gone or the review is stale. */
  resolve: (occurrence: string) => Clash | undefined;
  focusClash: (clash: Clash) => void;
  focusClashes: (clashes: readonly Clash[]) => void;
}

/** A row focuses its native occurrence; a missing or stale occurrence stays inert text. */
function FindingRow({ finding, clash, checked, onCheck, focusClash }: {
  finding: DraftFinding; clash: Clash | undefined; checked: boolean; onCheck: (on: boolean) => void; focusClash: (clash: Clash) => void;
}) {
  const { t } = useTranslation();
  const side = (codes: string[]) => codes.length ? codes.join('/') : t('assistant.disciplineUnknown');
  const label = `${finding.nativeType} · ${finding.nativeSeverity} · ${side(finding.disciplineCandidates.a)} ↔ ${side(finding.disciplineCandidates.b)}`;
  return <li className="flex items-start gap-1">
    <input type="checkbox" className="mt-1" checked={checked} onChange={event => onCheck(event.target.checked)}
      aria-label={t('clashApply.selectFinding', { citation: finding.citation })} />
    <button type="button" disabled={!clash} onClick={clash ? () => focusClash(clash) : undefined} title={t('assistant.clashFindingFocus')}
      className="grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-2 rounded px-1 py-0.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none">
      <span className="font-mono text-muted-foreground">{finding.citation}</span>
      <span className="min-w-0 break-words">{label}</span>
    </button>
  </li>;
}

function Stats({ draft }: { draft: ClashGroupDraft }) {
  const { t } = useTranslation();
  const counts = draftAccounting(draft);
  const sample = draft.origin.kind === 'sample';
  const label = sample
    ? t('assistant.clashGroupCounts', { total: draft.totalFindings, proposed: counts.grouped, unclassified: counts.unclassified,
      omitted: draft.origin.kind === 'sample' ? draft.origin.omittedFromEvidence : 0 })
    : t('clashApply.fullCounts', { total: draft.totalFindings, grouped: counts.grouped, unclassified: counts.unclassified,
      failed: counts.failed, notRun: counts.notRun });
  const cells = draft.origin.kind === 'sample'
    ? [['assistant.clashStatNative', draft.totalFindings], ['assistant.clashStatProposed', counts.grouped],
      ['assistant.clashStatUnclassified', counts.unclassified], ['assistant.clashStatOmitted', draft.origin.omittedFromEvidence]] as const
    : [['assistant.clashStatNative', draft.totalFindings], ['assistant.clashStatProposed', counts.grouped],
      ['assistant.clashStatUnclassified', counts.unclassified], ['clashApply.statFailed', counts.failed], ['clashApply.statNotRun', counts.notRun]] as const;
  return <dl aria-label={label} aria-live="polite" className="grid grid-cols-2 gap-1">
    {cells.map(([key, value]) => <div key={key} className="rounded bg-muted/50 px-2 py-1">
      <dt className="text-2xs text-muted-foreground">{t(key)}</dt><dd className="text-sm font-semibold tabular-nums">{value}</dd>
    </div>)}
  </dl>;
}

function GroupHeader({ group, draft, resolve, focusClashes, apply }: {
  group: DraftGroup; draft: ClashGroupDraft; resolve: EditorProps['resolve']; focusClashes: EditorProps['focusClashes'];
  apply: (edit: DraftEdit) => boolean;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const live = group.members.flatMap(occurrence => resolve(occurrence) ?? []);
  const others = draft.groups.filter(other => other.key !== group.key);
  return <>
    {renaming === null ? <h4 className="flex items-start gap-1 font-semibold">
      <span className="min-w-0 flex-1 break-words">{group.name}</span>
      <span className="shrink-0 pt-0.5 text-2xs font-normal text-muted-foreground">{t('assistant.proposalFindings', { count: group.members.length })}</span>
      <IconButton label={t('clashApply.rename', { name: group.name })} className="-my-1 h-6 w-6 shrink-0" onClick={() => setRenaming(group.name)}>
        <Pencil className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label={t('assistant.clashGroupFocus', { name: group.name })} className="-my-1 h-6 w-6 shrink-0"
        disabled={!live.length} onClick={() => focusClashes(live)}>
        <Crosshair className="h-3.5 w-3.5" />
      </IconButton>
    </h4> : <form className="flex items-center gap-1" onSubmit={event => {
      event.preventDefault();
      if (apply(renameDraftGroup(draft, group.key, renaming))) setRenaming(null);
    }}>
      <input aria-label={t('clashApply.groupName')} className={`${field} flex-1`} maxLength={100} value={renaming}
        onChange={event => setRenaming(event.target.value)} />
      <Button type="submit" size="sm" className="h-7">{t('clashApply.saveName')}</Button>
      <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setRenaming(null)}>{t('clashApply.cancelRename')}</Button>
    </form>}
    {others.length > 0 && <div className="flex items-center gap-1">
      <select aria-label={t('clashApply.mergeInto', { name: group.name })} className={`${field} flex-1`} value={mergeTarget}
        onChange={event => setMergeTarget(event.target.value)}>
        <option value="">{t('clashApply.mergeInto', { name: group.name })}</option>
        {others.map(other => <option key={other.key} value={other.key}>{other.name}</option>)}
      </select>
      <Button type="button" size="sm" variant="outline" className="h-7" disabled={!mergeTarget}
        onClick={() => { if (apply(mergeDraftGroups(draft, group.key, mergeTarget))) setMergeTarget(''); }}>{t('clashApply.merge')}</Button>
    </div>}
  </>;
}

/** Reviewed taxonomy edits: rename, move, split and merge, with live accounting. */
export function ClashGroupDraftEditor({ draft, onChange, resolve, focusClash, focusClashes }: EditorProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Selection and destination belong to one draft revision: an applied edit or a new proposal clears both
  // (group keys restart at g1 in a new proposal, so a kept destination could name an unrelated group).
  useEffect(() => { setSelected(new Set()); setTarget(''); }, [draft]);
  const apply = (edit: DraftEdit): boolean => {
    if (!edit.ok) { setError(t(`clashApply.edit.${edit.reason}`)); return false; }
    setError(null);
    onChange(edit.draft);
    return true;
  };
  const toggle = (occurrence: string, on: boolean) => setSelected(current => {
    const next = new Set(current);
    if (on) next.add(occurrence); else next.delete(occurrence);
    return next;
  });
  const move = () => {
    const destination = target === 'unclassified' ? null : target === 'new' ? { newGroup: newName } : { group: target };
    if (apply(moveDraftFindings(draft, [...selected], destination))) { setTarget(''); setNewName(''); }
  };
  const unclassified = draftUnclassified(draft);
  const row = (finding: DraftFinding) => <FindingRow key={finding.occurrence} finding={finding} clash={resolve(finding.occurrence)}
    checked={selected.has(finding.occurrence)} onCheck={on => toggle(finding.occurrence, on)} focusClash={focusClash} />;
  return <div className="space-y-2">
    <Stats draft={draft} />
    {draft.origin.kind === 'full-run' && draft.origin.unaddressable > 0 && <p className="text-muted-foreground">
      {t('clashApply.unaddressable', { count: draft.origin.unaddressable })}</p>}
    <p className="text-muted-foreground">{t('clashApply.reviewedNote')}</p>
    {draft.groups.map(group => <section key={group.key} className="rounded border border-border p-2 space-y-1" aria-label={group.name}>
      <GroupHeader group={group} draft={draft} resolve={resolve} focusClashes={focusClashes} apply={apply} />
      {group.explanation && <>
        <p className="whitespace-pre-wrap break-words">{group.explanation}</p>
        <p className="text-2xs italic text-muted-foreground">{t('assistant.clashGroupInference')}</p>
      </>}
      <ul className="border-t border-border pt-1">{group.members.map(occurrence => row(draft.findings.get(occurrence)!))}</ul>
    </section>)}
    {unclassified.length > 0 && <section className="rounded border border-dashed border-border p-2 space-y-1"
      aria-label={t('clashApply.unclassifiedTitle', { count: unclassified.length })}>
      <h4 className="font-semibold">{t('clashApply.unclassifiedTitle', { count: unclassified.length })}</h4>
      <ul>{unclassified.map(row)}</ul>
    </section>}
    {selected.size > 0 && <div className="sticky bottom-0 space-y-1 rounded border border-primary/40 bg-background p-2">
      <p className="font-medium">{t('clashApply.selected', { count: selected.size })}</p>
      <div className="flex flex-wrap items-center gap-1">
        <select aria-label={t('clashApply.moveTo')} className={`${field} flex-1`} value={target} onChange={event => setTarget(event.target.value)}>
          <option value="">{t('clashApply.moveTo')}</option>
          {draft.groups.map(group => <option key={group.key} value={group.key}>{group.name}</option>)}
          <option value="new">{t('clashApply.moveTarget.new')}</option>
          <option value="unclassified">{t('clashApply.moveTarget.unclassified')}</option>
        </select>
        {target === 'new' && <input aria-label={t('clashApply.newGroupName')} placeholder={t('clashApply.newGroupName')} maxLength={100}
          className={`${field} flex-1`} value={newName} onChange={event => setNewName(event.target.value)} />}
        <Button type="button" size="sm" className="h-7" disabled={!target} onClick={move}>{t('clashApply.move')}</Button>
      </div>
    </div>}
    {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
  </div>;
}
