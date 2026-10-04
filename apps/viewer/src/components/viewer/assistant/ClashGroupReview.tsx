/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { useAssistant } from '@/lib/assistant/conversation';
import { evidenceIsCurrent } from '@/lib/assistant/evidence';
import { prepareClashGroupPreview, type ClashGroupPreview } from '@/lib/assistant/clash-group-proposal';
import { EvidenceView } from '../analysis/EvidenceView';
import { proposalOf } from './AssistantConversation';

type Finding = ClashGroupPreview['groups'][number]['findings'][number];

function FindingRow({ finding }: { finding: Finding }) {
  const { t } = useTranslation();
  const side = (codes: string[]) => codes.length ? codes.join('/') : t('assistant.disciplineUnknown');
  return <li className="grid grid-cols-[auto_1fr] gap-x-2 py-0.5">
    <span className="font-mono text-muted-foreground">{finding.citation}</span>
    <span className="min-w-0 break-words">{finding.nativeType} · {finding.nativeSeverity} · {side(finding.disciplineCandidates.a)} ↔ {side(finding.disciplineCandidates.b)}</span>
  </li>;
}

export function ClashGroupReview() {
  const { t } = useTranslation();
  const assistant = useAssistant();
  const [preview, setPreview] = useState<ClashGroupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Native edits must refresh the visible freshness guard.
  useViewerStore(state => state);
  const reply = assistant.messages.at(-1);
  const proposed = useMemo(() => reply?.role === 'assistant' && proposalOf(reply.content)?.kind === 'clash', [reply]);
  const eligible = assistant.snapshot?.source === 'clash' && evidenceIsCurrent(assistant.snapshot)
    && proposed && assistant.status !== 'streaming' && assistant.error !== 'truncated-output';
  const stale = preview ? !evidenceIsCurrent(preview.evidence) : false;
  if (!proposed && !preview && !error) return null;
  return <section aria-label={t('assistant.clashGroupReview')} className="mx-3 my-2 rounded border border-border text-xs">
    <h3 className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold">
      <Layers className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('assistant.clashGroupReview')}
    </h3>
    <div className="p-2 space-y-2">
      {!preview && <p className="text-muted-foreground">{t('assistant.clashGroupHint')}</p>}
      <Button size="sm" variant={preview ? 'outline' : 'default'} className="h-7" disabled={!eligible} onClick={() => {
        try { setPreview(prepareClashGroupPreview(reply!.content, assistant.snapshot!)); setError(null); }
        catch (error) { setPreview(null); setError(error instanceof Error ? error.message : String(error)); }
      }}>{t('assistant.previewClashGroups')}</Button>
      {preview && <>
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
          <h4 className="flex items-baseline justify-between gap-2 font-semibold">
            <span className="min-w-0 break-words">{group.name}</span>
            <span className="shrink-0 text-2xs font-normal text-muted-foreground">{t('assistant.proposalFindings', { count: group.findings.length })}</span>
          </h4>
          <p className="whitespace-pre-wrap break-words">{group.explanation}</p>
          <p className="text-2xs italic text-muted-foreground">{t('assistant.clashGroupInference')}</p>
          <ul className="border-t border-border pt-1">{group.findings.map(finding => <FindingRow key={finding.occurrence} finding={finding} />)}</ul>
        </section>)}
        <details><summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('assistant.evidenceDetails')}</summary>
          <div className="mt-2"><EvidenceView evidence={preview.evidence} state={stale ? 'stale' : 'captured'} /></div>
        </details>
      </>}
      {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
    </div>
  </section>;
}
