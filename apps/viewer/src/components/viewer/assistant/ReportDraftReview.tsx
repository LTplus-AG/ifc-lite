/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useViewerStore } from '@/store';
import { useAssistant } from '@/lib/assistant/conversation';
import { prepareReportDraft, isReportDraftCurrent, saveReportDraft, type ReportDraft } from '@/lib/assistant/report-draft';
import { exportDocument } from '@/lib/document/persistence';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { EvidenceView } from '../analysis/EvidenceView';

export function ReportDraftReview() {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const assistant = useAssistant();
  const store = useViewerStore();
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const evidence = assistant.snapshot ?? assistant.archived?.evidence;
  if ((!evidence || evidence.source === 'flow') && !draft) return null;
  const eligible = !!evidence && evidence.source !== 'flow' && assistant.status === 'idle' && !assistant.error
    && assistant.messages.at(-1)?.role === 'assistant';
  const current = draft && isReportDraftCurrent(draft);
  const save = async () => {
    if (!draft || !approved || busy) return;
    setBusy(true); setError(null);
    try { setSaved(await saveReportDraft(draft, draft.documentJson)); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!eligible && !draft) return null;
  return <details className="mx-3 my-2 rounded border border-border text-xs">
    <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 font-semibold">
      <FileText className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('assistant.reportReview')}
    </summary>
    <div className="border-t border-border p-2 space-y-2">
      <p className="text-muted-foreground">{t('assistant.reportHint')}</p>
      <label className="sr-only" htmlFor="assistant-report-name">{t('assistant.reportName')}</label>
      <div className="flex items-center gap-1">
        <input id="assistant-report-name" className="min-w-0 flex-1 h-7 border border-input rounded bg-background px-2" value={name}
          maxLength={200} disabled={busy} placeholder={t('assistant.reportName')} onChange={event => { setName(event.target.value); setApproved(false); }} />
      <Button variant="outline" size="sm" className="h-7 shrink-0" disabled={!eligible || busy} onClick={() => {
        try { setDraft(prepareReportDraft(name)); setApproved(false); setSaved(false); setError(null); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      }}>{t('assistant.prepareReport')}</Button>
      </div>
      {draft && <>
        <p className="font-semibold">{draft.document.name}</p>
        <EvidenceView evidence={draft.source.evidence} state="historical" />
        <p>{draft.source.messages.at(-1)?.model}</p>
        <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-2 max-h-64 overflow-auto">{draft.source.messages.at(-1)?.content}</blockquote>
        <details><summary>{t('assistant.reportContents')}</summary><pre className="whitespace-pre-wrap break-words max-h-64 overflow-auto">{draft.documentJson}</pre></details>
        {!current && !saved && <p role="alert">{t('assistant.reportStale')}</p>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={approved} disabled={!current || busy || saved}
          onChange={event => setApproved(event.target.checked)} />{t('assistant.reportApproved')}</label>
        <Button size="sm" disabled={!approved || !current || busy || saved} onClick={() => void save()}>{t('assistant.saveReport')}</Button>
        <Button variant="outline" size="sm" disabled={!approved || busy} onClick={() => exportDocument(draft.document)}>{t('assistant.exportReport')}</Button>
        {saved && <><p>{t('assistant.reportSaved')}</p><Button variant="outline" size="sm" onClick={() => {
          store.setActiveDocumentId(draft.document.id); panels.openInHome('document');
        }}>{t('assistant.openReport')}</Button></>}
      </>}
      {error && <p role="alert">{error}</p>}
    </div>
    <ContentStorageNotice status={store.documentsStorage} retry={store.retryDocumentsSave} restore={store.restoreDocuments} />
  </details>;
}
