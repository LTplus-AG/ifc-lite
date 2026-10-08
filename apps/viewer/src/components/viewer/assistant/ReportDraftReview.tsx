/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useViewerStore } from '@/store';
import { useAssistant } from '@/lib/assistant/conversation';
import { evidenceIsCurrent } from '@/lib/assistant/evidence';
import { ASSISTANT_PROXY_URL, sendAssistant } from '@/lib/assistant/request';
import { contradictedClaims, prepareReportDraft, isReportDraftCurrent, reviseReportClaim, saveReportDraft, type ReportDraft } from '@/lib/assistant/report-draft';
import { declaredLanguageDiffers, defaultReportLanguage, isReportLanguage, REPORT_LANGUAGES, reportLanguageInstruction, reportLanguageName, type ReportLanguage } from '@/lib/assistant/report-language';
import { exportDocument } from '@/lib/document/persistence';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { EvidenceView } from '../analysis/EvidenceView';
import { ReportClaimList } from './ReportClaimList';
import { isReportSource } from '@/lib/assistant/sources';

export function ReportDraftReview() {
  const { t, locale } = useTranslation();
  const panels = usePanelControls();
  const assistant = useAssistant();
  const store = useViewerStore();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<ReportLanguage>(() => defaultReportLanguage(locale));
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const evidence = assistant.snapshot ?? assistant.archived?.evidence;
  if ((!evidence || !isReportSource(evidence.source)) && !draft) return null;
  const eligible = !!evidence && isReportSource(evidence.source) && assistant.status === 'idle' && !assistant.error
    && assistant.messages.at(-1)?.role === 'assistant';
  const canRequest = !!assistant.snapshot && assistant.status !== 'streaming' && evidenceIsCurrent(assistant.snapshot);
  const current = draft && isReportDraftCurrent(draft);
  const blocked = draft ? contradictedClaims(draft).length > 0 : false;
  const fail = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
  const save = async () => {
    if (!draft || !approved || busy || blocked) return;
    setBusy(true); setError(null);
    try { setSaved(await saveReportDraft(draft, draft.documentJson)); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const revise = (claimId: string, edit: { text: string } | 'remove') => {
    if (!draft) return;
    try { setDraft(reviseReportClaim(draft, claimId, edit)); setApproved(false); setError(null); }
    catch (error) { fail(error); }
  };
  const requestDraft = () => {
    setError(null);
    void sendAssistant(t('aiReports.requestPrompt', { instruction: reportLanguageInstruction(language) }), store.chatActiveModel, ASSISTANT_PROXY_URL, {}, { generationLanguage: language });
  };
  // Stays mounted while a requested draft streams, so the open review keeps its place.
  if (!eligible && !draft && !assistant.snapshot) return null;
  return <details className="mx-3 my-2 rounded border border-border text-xs">
    <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 font-semibold">
      <FileText className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('assistant.reportReview')}
    </summary>
    <div className="border-t border-border p-2 space-y-2">
      <p className="text-muted-foreground">{t('assistant.reportHint')}</p>
      <div className="flex flex-wrap items-center gap-1">
        <label className="text-muted-foreground" htmlFor="assistant-report-language">{t('aiReports.language')}</label>
        <select id="assistant-report-language" className="h-7 rounded border border-input bg-background px-1" value={language} disabled={busy}
          title={t('aiReports.languageHint')} onChange={event => { if (isReportLanguage(event.target.value)) setLanguage(event.target.value); }}>
          {REPORT_LANGUAGES.map(tag => <option key={tag} value={tag}>{reportLanguageName(tag, locale)}</option>)}
        </select>
        <Button variant="outline" size="sm" className="h-7" disabled={!canRequest || busy} onClick={requestDraft}>
          <Sparkles className="h-3 w-3 mr-1" aria-hidden="true" />{t('aiReports.draftWithAi')}</Button>
      </div>
      <label className="sr-only" htmlFor="assistant-report-name">{t('assistant.reportName')}</label>
      <div className="flex items-center gap-1">
        <input id="assistant-report-name" className="min-w-0 flex-1 h-7 border border-input rounded bg-background px-2" value={name}
          maxLength={200} disabled={busy} placeholder={t('assistant.reportName')} onChange={event => { setName(event.target.value); setApproved(false); }} />
      <Button variant="outline" size="sm" className="h-7 shrink-0" disabled={!eligible || busy} onClick={() => {
        try { setDraft(prepareReportDraft(name, language)); setApproved(false); setSaved(false); setError(null); }
        catch (error) { fail(error); }
      }}>{t('assistant.prepareReport')}</Button>
      </div>
      {draft && <>
        <div>
          <p className="font-semibold break-words">{draft.document.name}</p>
          <p className="text-2xs text-muted-foreground">{draft.source.messages.at(-1)?.model} · {reportLanguageName(draft.language, locale)}</p>
        </div>
        {declaredLanguageDiffers(draft.declaredLanguage, draft.language) && <output className="block rounded border border-amber-500/40 bg-amber-500/10 p-2">
          {t('aiReports.languageMismatch', { declared: draft.declaredLanguage ?? '', chosen: draft.language })}</output>}
        {draft.prose.trim() && <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-2">{draft.prose}</blockquote>}
        <ReportClaimList key={draft.document.id} claims={draft.claims} disabled={busy || saved || !current} onEdit={(id, text) => revise(id, { text })} onRemove={id => revise(id, 'remove')} />
        <details><summary className="cursor-pointer py-1 text-muted-foreground hover:text-foreground">{t('assistant.evidenceDetails')}</summary>
          <div className="mt-2"><EvidenceView evidence={draft.source.evidence} state="historical" /></div>
        </details>
        <details><summary className="cursor-pointer py-1 text-muted-foreground hover:text-foreground">{t('assistant.reportContents')}</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{draft.documentJson}</pre></details>
        {!current && !saved && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('assistant.reportStale')}</p>}
        <label className="flex min-h-6 items-center gap-2"><input type="checkbox" className="h-4 w-4 shrink-0" checked={approved} disabled={!current || busy || saved}
          onChange={event => setApproved(event.target.checked)} />{t('assistant.reportApproved')}</label>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" className="h-7" disabled={!approved || !current || busy || saved || blocked} onClick={() => void save()}>{t('assistant.saveReport')}</Button>
          <Button variant="outline" size="sm" className="h-7" disabled={!approved || busy || blocked} onClick={() => exportDocument(draft.document)}>{t('assistant.exportReport')}</Button>
        </div>
        {saved && <div aria-live="polite" className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 space-y-2">
          <p>{t('assistant.reportSaved')}</p>
          <Button variant="outline" size="sm" className="h-7" onClick={() => {
            store.setActiveDocumentId(draft.document.id); panels.openInHome('document');
          }}>{t('assistant.openReport')}</Button>
        </div>}
      </>}
      {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
    </div>
    <ContentStorageNotice status={store.documentsStorage} retry={store.retryDocumentsSave} restore={store.restoreDocuments} />
  </details>;
}
