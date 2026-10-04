/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { Crosshair, Layers } from 'lucide-react';
import type { Clash } from '@ifc-lite/clash';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useClash } from '@/hooks/useClash';
import { manualClashOccurrenceKey } from '@/lib/clash/manual-groups';
import { useAssistant } from '@/lib/assistant/conversation';
import { evidenceIsCurrent } from '@/lib/assistant/evidence';
import { normalizeClashGroupAnswer, prepareClashGroupPreview, type ClashGroupPreview, type NormalizedClashAnswer } from '@/lib/assistant/clash-group-proposal';
import { EvidenceView } from '../analysis/EvidenceView';
import { proposalOf } from './AssistantConversation';

type Finding = ClashGroupPreview['groups'][number]['findings'][number];

/** A row focuses its native occurrence; a missing or stale occurrence stays inert text. */
function FindingRow({ finding, onFocus }: { finding: Finding; onFocus: (() => void) | null }) {
  const { t } = useTranslation();
  const side = (codes: string[]) => codes.length ? codes.join('/') : t('assistant.disciplineUnknown');
  const label = `${finding.nativeType} · ${finding.nativeSeverity} · ${side(finding.disciplineCandidates.a)} ↔ ${side(finding.disciplineCandidates.b)}`;
  return <li>
    <button type="button" disabled={!onFocus} onClick={onFocus ?? undefined} title={t('assistant.clashFindingFocus')}
      className="grid w-full grid-cols-[auto_1fr] gap-x-2 rounded px-1 py-0.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none">
      <span className="font-mono text-muted-foreground">{finding.citation}</span>
      <span className="min-w-0 break-words">{label}</span>
    </button>
  </li>;
}

export function ClashGroupReview() {
  const { t } = useTranslation();
  const assistant = useAssistant();
  const [preview, setPreview] = useState<ClashGroupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adjusted, setAdjusted] = useState<NormalizedClashAnswer | null>(null);
  // Native edits must refresh the visible freshness guard.
  useViewerStore(state => state);
  const reply = assistant.messages.at(-1);
  const parsed = useMemo(() => reply?.role === 'assistant' ? proposalOf(reply.content) : null, [reply]);
  const proposed = parsed?.kind === 'clash';
  const live = assistant.snapshot?.source === 'clash' && evidenceIsCurrent(assistant.snapshot)
    && assistant.status !== 'streaming' && assistant.error !== 'truncated-output';
  const eligible = live && proposed;
  // A refused proposal can still be previewed, but only by explicit choice and with its adjustments disclosed.
  const normalized = useMemo(() => parsed?.kind === 'invalid' && parsed.declared === 'clash' && assistant.snapshot
    ? normalizeClashGroupAnswer(reply!.content, assistant.snapshot) : null, [parsed, reply, assistant.snapshot]);
  const stale = preview ? !evidenceIsCurrent(preview.evidence) : false;
  const { result, focusClash, focusClashes } = useClash();
  // Resolve against the live native report; a stale preview never drives the scene.
  const native = useMemo(() => new Map((result?.clashes ?? []).map(clash => [manualClashOccurrenceKey(clash), clash])), [result]);
  const resolve = (findings: Finding[]): Clash[] => stale ? [] : findings.flatMap(finding => native.get(finding.occurrence) ?? []);
  if (!proposed && !normalized && !preview && !error) return null;
  return <section aria-label={t('assistant.clashGroupReview')} className="mx-3 my-2 rounded border border-border text-xs">
    <h3 className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold">
      <Layers className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('assistant.clashGroupReview')}
    </h3>
    <div className="p-2 space-y-2">
      {!preview && <p className="text-muted-foreground">{t(proposed ? 'assistant.clashGroupHint' : 'assistant.clashGroupAdjustHint')}</p>}
      {proposed && <Button size="sm" variant={preview ? 'outline' : 'default'} className="h-7" disabled={!eligible} onClick={() => {
        try { setPreview(prepareClashGroupPreview(reply!.content, assistant.snapshot!)); setAdjusted(null); setError(null); }
        catch (error) { setPreview(null); setError(error instanceof Error ? error.message : String(error)); }
      }}>{t('assistant.previewClashGroups')}</Button>}
      {!proposed && normalized && <Button size="sm" variant={preview ? 'outline' : 'default'} className="h-7" disabled={!live} onClick={() => {
        try { setPreview(prepareClashGroupPreview(normalized.answer, assistant.snapshot!)); setAdjusted(normalized); setError(null); }
        catch (error) { setPreview(null); setError(error instanceof Error ? error.message : String(error)); }
      }}>{t('assistant.previewAdjusted')}</Button>}
      {preview && <>
        {adjusted && <p role="note" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('assistant.clashGroupAdjusted', {
          repeats: adjusted.removedRepeats, unknown: adjusted.removedUnknown, groups: adjusted.droppedGroups })}</p>}
        {stale && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('assistant.stale')}</p>}
        <dl aria-label={t('assistant.clashGroupCounts', { total: preview.totalFindings, proposed: preview.proposedFindings,
          unclassified: preview.unclassifiedFindings, omitted: preview.omittedFromEvidence })} className="grid grid-cols-2 gap-1">
          {([['assistant.clashStatNative', preview.totalFindings], ['assistant.clashStatProposed', preview.proposedFindings],
            ['assistant.clashStatUnclassified', preview.unclassifiedFindings], ['assistant.clashStatOmitted', preview.omittedFromEvidence]] as const)
            .map(([label, value]) => <div key={label} className="rounded bg-muted/50 px-2 py-1">
              <dt className="text-2xs text-muted-foreground">{t(label)}</dt><dd className="text-sm font-semibold tabular-nums">{value}</dd>
            </div>)}
        </dl>
        <p className="text-muted-foreground">{t('assistant.clashGroupInert')}</p>
        {preview.groups.map((group, index) => <section key={index} className="rounded border border-border p-2 space-y-1" aria-label={group.name}>
          <h4 className="flex items-start gap-1 font-semibold">
            <span className="min-w-0 flex-1 break-words">{group.name}</span>
            <span className="shrink-0 pt-0.5 text-2xs font-normal text-muted-foreground">{t('assistant.proposalFindings', { count: group.findings.length })}</span>
            <IconButton label={t('assistant.clashGroupFocus', { name: group.name })} className="-my-1 h-6 w-6 shrink-0"
              disabled={!resolve(group.findings).length} onClick={() => focusClashes(resolve(group.findings))}>
              <Crosshair className="h-3.5 w-3.5" />
            </IconButton>
          </h4>
          <p className="whitespace-pre-wrap break-words">{group.explanation}</p>
          <p className="text-2xs italic text-muted-foreground">{t('assistant.clashGroupInference')}</p>
          <ul className="border-t border-border pt-1">{group.findings.map(finding => {
            const clash = resolve([finding])[0];
            return <FindingRow key={finding.occurrence} finding={finding} onFocus={clash ? () => focusClash(clash) : null} />;
          })}</ul>
        </section>)}
        <details><summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('assistant.evidenceDetails')}</summary>
          <div className="mt-2"><EvidenceView evidence={preview.evidence} state={stale ? 'stale' : 'captured'} /></div>
        </details>
      </>}
      {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
    </div>
  </section>;
}
