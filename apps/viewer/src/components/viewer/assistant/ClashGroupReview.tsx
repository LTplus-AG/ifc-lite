/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { useAssistant } from '@/lib/assistant/conversation';
import { evidenceIsCurrent } from '@/lib/assistant/evidence';
import { prepareClashGroupPreview, type ClashGroupPreview } from '@/lib/assistant/clash-group-proposal';
import { EvidenceView } from '../analysis/EvidenceView';

export function ClashGroupReview() {
  const { t } = useTranslation();
  const assistant = useAssistant();
  const [preview, setPreview] = useState<ClashGroupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useViewerStore(state => state);
  const reply = assistant.messages.at(-1);
  const eligible = assistant.snapshot?.source === 'clash' && evidenceIsCurrent(assistant.snapshot)
    && reply?.role === 'assistant' && assistant.status !== 'streaming' && assistant.error !== 'truncated-output';
  const stale = preview ? !evidenceIsCurrent(preview.evidence) : false;
  return <details className="border-b border-border text-xs shrink-0">
    <summary className="cursor-pointer p-3">{t('assistant.clashGroupReview')}</summary>
    <div className="px-3 pb-3 space-y-2 max-h-80 overflow-auto">
      <p>{t('assistant.clashGroupHint')}</p>
      <Button size="sm" variant="outline" disabled={!eligible} onClick={() => {
        try { setPreview(prepareClashGroupPreview(reply!.content, assistant.snapshot!)); setError(null); }
        catch (error) { setPreview(null); setError(error instanceof Error ? error.message : String(error)); }
      }}>{t('assistant.previewClashGroups')}</Button>
      {preview && <>
        <EvidenceView evidence={preview.evidence} state={stale ? 'stale' : 'captured'} />
        {stale && <p role="alert">{t('assistant.stale')}</p>}
        <p>{t('assistant.clashGroupCounts', { total: preview.totalFindings, proposed: preview.proposedFindings,
          unclassified: preview.unclassifiedFindings, omitted: preview.omittedFromEvidence })}</p>
        <p>{t('assistant.clashGroupInert')}</p>
        {preview.groups.map((group, index) => <section key={index} className="border border-border rounded p-2 space-y-1" aria-label={group.name}>
          <h3 className="text-xs font-semibold">{group.name}</h3>
          <p>{t('assistant.clashGroupInference')}</p><p className="whitespace-pre-wrap break-words">{group.explanation}</p>
          <pre className="whitespace-pre-wrap break-words">{JSON.stringify(group.findings, null, 2)}</pre>
        </section>)}
      </>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
