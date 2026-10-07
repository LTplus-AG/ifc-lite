/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { useSemanticSession } from '@/lib/semantic/session';
import { attachSourceText, detachSourceText, useSemanticSourceTexts } from '@/lib/semantic/assist/source-texts';
import { semanticReviewLibrary, useSemanticReviews } from '@/lib/semantic/assist/library';
import { revisionPinIsCurrent } from '@/lib/semantic/assist/revision-pin';
import { validateStoredReview } from '@/lib/semantic/assist/review-validate';
import '@/i18n/catalogues/semantic-assist.register';

const control = 'w-full rounded border border-border bg-background p-2 text-sm';
const button = 'rounded border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50';

/** Texts explicitly attached for the assistant, and the reviewed mappings/requirements saved from it. */
export function SemanticAssistControls({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation();
  const sources = useSemanticSourceTexts(s => s.sources);
  const document = useSemanticSession(s => s.document);
  const profile = useSemanticSession(s => s.profile);
  const revisions = useSemanticSession(s => s.revisions);
  const models = useViewerStore(s => s.models);
  const stored = useSemanticReviews(s => s.entries);
  // Stored proposals are opaque until read: the strict decoders decide what is listed, the rest is kept and counted.
  const reviews = useMemo(() => stored.flatMap(entry => validateStoredReview(entry) ?? []), [stored]);
  const unreadable = stored.length - reviews.length;
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const attach = (name: string, value: string) => {
    try { attachSourceText(name, value); setTitle(''); setText(''); }
    catch (failure) { onError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <details>
    <summary>{t('semanticAssist.controlsTitle')}</summary>
    <p className="text-sm text-muted-foreground">{t('semanticAssist.controlsHelp')}</p>
    <label className="block text-sm">{t('semanticAssist.sourceTitle')}<input className={control} value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>
    <label className="block text-sm">{t('semanticAssist.sourceText')}<textarea className={control} rows={5} value={text} onChange={event => setText(event.target.value)} /></label>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={!text.trim()} onClick={() => attach(title || t('semanticAssist.pastedSpecification'), text)}>{t('semanticAssist.attachText')}</button>
      <button className={button} disabled={!document} onClick={() => document && attach(t('semanticAssist.recordsDocument'), JSON.stringify({ ...document, source: undefined }, null, 2))}>{t('semanticAssist.attachRecords')}</button>
    </div>
    <ul className="text-sm">{sources.map(source => <li key={source.id} className="flex items-center justify-between gap-2">
      <span className="min-w-0 break-words">{t('semanticAssist.attached', { id: source.id, title: source.title, characters: source.text.length })}</span>
      <button className={button} aria-label={t('semanticAssist.detachLabel', { id: source.id })} onClick={() => detachSourceText(source.id)}>{t('semanticAssist.detach')}</button>
    </li>)}</ul>
    <h4 className="font-medium">{t('semanticAssist.savedTitle')}</h4>
    {!stored.length && <p className="text-sm text-muted-foreground">{t('semanticAssist.savedNone')}</p>}
    {unreadable > 0 && <output className="block text-sm text-muted-foreground">{t('semanticAssist.savedUnreadable', { count: unreadable })}</output>}
    <ul className="space-y-1 text-sm">{reviews.map(entry => {
      const historical = entry.type === 'mapping' && (!revisionPinIsCurrent(entry.pin, revisions, models) || entry.profile.identity !== JSON.stringify(profile));
      return <li key={entry.id} className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words">
          {entry.proposal.title} · {entry.type === 'mapping'
            ? t('semanticAssist.savedMapping', { count: entry.approved.length, revision: entry.proposal.modelRevision })
            : t('semanticAssist.savedRequirements', { verified: entry.spans.filter(status => status === 'verified').length, count: entry.spans.length, unsupported: entry.unsupportedSpans.length })}
          {entry.type === 'mapping' && <span className="ml-1 rounded bg-muted px-1 text-xs">{t(historical ? 'semanticAssist.historical' : 'semanticAssist.current')}</span>}
        </span>
        <button className={button} aria-label={t('semanticAssist.deleteLabel', { title: entry.proposal.title })} onClick={() => void semanticReviewLibrary.put(entry.id, null)}>{t('semanticAssist.delete')}</button>
      </li>;
    })}</ul>
  </details>;
}
