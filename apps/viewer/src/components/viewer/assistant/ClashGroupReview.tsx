/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import type { ClashResult } from '@ifc-lite/clash';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { useClash } from '@/hooks/useClash';
import { manualClashOccurrenceKey } from '@/lib/clash/manual-groups';
import type { ClashGroupApplication } from '@/lib/clash/group-applications';
import { useAssistant } from '@/lib/assistant/conversation';
import { evidenceIsCurrent } from '@/lib/assistant/evidence';
import { normalizeClashGroupAnswer, prepareClashGroupPreview, type ClashGroupPreview, type NormalizedClashAnswer } from '@/lib/assistant/clash-group-proposal';
import { draftFromPreview, type ClashGroupDraft } from '@/lib/assistant/clash-group-draft';
import { draftFromClassification } from '@/lib/assistant/clash-classify-run';
import { EvidenceView } from '../analysis/EvidenceView';
import { proposalOf } from './AssistantConversation';
import { ClashGroupDraftEditor } from './ClashGroupDraftEditor';
import { ClashGroupApply } from './ClashGroupApply';
import { ClashGroupApplicationCard } from './ClashGroupApplicationCard';
import { ClashClassifyAll } from './ClashClassifyAll';

/** A review draft belongs to one native run; `preview` is set for the discussion sample. */
interface Review { draft: ClashGroupDraft; result: ClashResult; preview: ClashGroupPreview | null; origin: string }

export function ClashGroupReview() {
  const { t } = useTranslation();
  const assistant = useAssistant();
  const [review, setReview] = useState<Review | null>(null);
  const [receipt, setReceipt] = useState<ClashGroupApplication | null>(null);
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
  const { result, focusClash, focusClashes } = useClash();
  const stale = review ? (review.preview ? !evidenceIsCurrent(review.preview.evidence) : result !== review.result) : false;
  // Resolve against the live native report; a stale review never drives the scene.
  const native = useMemo(() => new Map((result?.clashes ?? []).map(clash => [manualClashOccurrenceKey(clash), clash])), [result]);
  const resolve = (occurrence: string) => stale ? undefined : native.get(occurrence);
  const begin = (answer: string, adjustment: NormalizedClashAnswer | null) => {
    try {
      const preview = prepareClashGroupPreview(answer, assistant.snapshot!);
      setReview({ draft: draftFromPreview(preview), result: result!, preview, origin: `assistant:${preview.evidence.id}` });
      setAdjusted(adjustment); setReceipt(null); setError(null);
    } catch (failure) { setReview(null); setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  if (!live && !proposed && !normalized && !review && !error) return null;
  return <section aria-label={t('assistant.clashGroupReview')} className="mx-3 my-2 rounded border border-border text-xs">
    <h3 className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold">
      <Layers className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('assistant.clashGroupReview')}
    </h3>
    <div className="p-2 space-y-2">
      {!review && (proposed || normalized) && <p className="text-muted-foreground">{t(proposed ? 'assistant.clashGroupHint' : 'assistant.clashGroupAdjustHint')}</p>}
      {proposed && <Button size="sm" variant={review ? 'outline' : 'default'} className="h-7" disabled={!eligible}
        onClick={() => begin(reply!.content, null)}>{t('assistant.previewClashGroups')}</Button>}
      {!proposed && normalized && <Button size="sm" variant={review ? 'outline' : 'default'} className="h-7" disabled={!live}
        onClick={() => begin(normalized.answer, normalized)}>{t('assistant.previewAdjusted')}</Button>}
      {live && result && !receipt && <ClashClassifyAll result={result} enabled={live} onResult={run => {
        setReview({ draft: draftFromClassification(run), result, preview: null, origin: `classify-all:${assistant.snapshot!.id}` });
        setAdjusted(null); setReceipt(null); setError(null);
      }} />}
      {review && <>
        {adjusted && review.preview && <p role="note" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('assistant.clashGroupAdjusted', {
          repeats: adjusted.removedRepeats, unknown: adjusted.removedUnknown, groups: adjusted.droppedGroups })}</p>}
        {stale && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('assistant.stale')}</p>}
        {receipt ? <ClashGroupApplicationCard receipt={receipt} /> : <>
          <ClashGroupDraftEditor draft={review.draft} onChange={draft => setReview({ ...review, draft })} resolve={resolve}
            focusClash={focusClash} focusClashes={clashes => focusClashes(clashes)} />
          <ClashGroupApply draft={review.draft} clashes={stale ? undefined : result?.clashes} enabled={!stale} origin={review.origin} onApplied={setReceipt} />
        </>}
        {review.preview && <details><summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('assistant.evidenceDetails')}</summary>
          <div className="mt-2"><EvidenceView evidence={review.preview.evidence} state={stale ? 'stale' : 'captured'} /></div>
        </details>}
      </>}
      {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
    </div>
  </section>;
}
