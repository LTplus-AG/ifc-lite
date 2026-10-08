/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review of a `document.outline` draft (#6915): edit headings and text, see
 * each validation table resolved against the live native report right now,
 * then save a new native document and open it in the Documents panel.
 */

import { useMemo, useState } from 'react';
import { FileText, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { prepareDocumentDraft, type DocumentOutline, type OutlineBlock } from '@/lib/check-authoring/document-outline';
import { saveDocumentDraft } from '@/lib/check-authoring/save';
import { resolveValidationTableState } from '@/lib/document/resolve-validation-table';
import type { ValidationTableSource } from '@/lib/document/types';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { Notice, ReviewCard, TextField, UnsupportedList } from './DraftParts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** What a validation table would print now: its live row count, or why it has none. */
function LiveTable({ block, evidence }: { block: Extract<OutlineBlock, { kind: 'validationTable' }>; evidence: object | null }) {
  const { t } = useTranslation();
  const report = useViewerStore(s => s.idsValidationReport);
  const models = useViewerStore(s => s.models);
  const source: ValidationTableSource = { kind: 'validation', rows: block.rows, columns: block.columns, ...(block.specification ? { ruleId: block.specification } : {}) };
  const state = resolveValidationTableState(source, report, id => models.get(id)?.name ?? id);
  const target = block.specification ?? t('checkAuthoring.allChecks');
  // Specification ids are positional: another report may give this id to a different specification.
  if (block.specification && report !== evidence) {
    return <p className="break-words"><span className="font-medium">{block.title ?? t('checkAuthoring.validationTable')}</span>{' '}
      <span className="text-destructive">{t('checkAuthoring.liveEvidenceChanged', { target })}</span></p>;
  }
  return <p className="break-words">
    <span className="font-medium">{block.title ?? t('checkAuthoring.validationTable')}</span>{' '}
    <span className="text-muted-foreground">{state.status === 'ok' && state.kind === 'validation'
      ? t('checkAuthoring.liveRows', { count: state.model.totalRows, rows: block.rows, target })
      : t(state.status === 'rule-not-found' ? 'checkAuthoring.liveRuleMissing' : 'checkAuthoring.liveNoReport', { target })}</span>
  </p>;
}

/** `evidence` is the validation report the conversation was drafted from (its evidence identity), or null. */
export function DocumentOutlineReview({ initial, evidence }: { initial: DocumentOutline; evidence: object | null }) {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const report = useViewerStore(s => s.idsValidationReport);
  const storage = useViewerStore(s => s.documentsStorage);
  const retrySave = useViewerStore(s => s.retryDocumentsSave);
  const restore = useViewerStore(s => s.restoreDocuments);
  const setActiveDocumentId = useViewerStore(s => s.setActiveDocumentId);
  const [outline, setOutline] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prepared = useMemo(() => {
    try { return { draft: prepareDocumentDraft(outline, report, evidence), error: null }; }
    catch (failure) { return { draft: null, error: message(failure) }; }
  }, [outline, report, evidence]);
  const setSection = (index: number, change: (section: DocumentOutline['sections'][number]) => DocumentOutline['sections'][number]) =>
    setOutline({ ...outline, sections: outline.sections.map((section, i) => i === index ? change(section) : section) });
  const save = async () => {
    if (!prepared.draft) return;
    setBusy(true); setError(null);
    try { if (await saveDocumentDraft(prepared.draft)) setSavedId(prepared.draft.document.id); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };
  const locked = busy || savedId !== null;
  return <ReviewCard label={t('checkAuthoring.documentTitle')} icon={<FileText className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}>
    <TextField id="outline-title" label={t('checkAuthoring.draftTitle')} value={outline.title} disabled={locked} onChange={title => setOutline({ ...outline, title })} />
    {outline.rationale && <p className="text-muted-foreground break-words">{outline.rationale}</p>}
    <p className="text-muted-foreground">{t('checkAuthoring.documentHint')}</p>
    <ol aria-label={t('checkAuthoring.sections')} className="space-y-1.5">
      {outline.sections.map((section, s) => <li key={s} className="rounded border border-border p-2 space-y-1.5">
        <TextField id={`outline-${s}-heading`} label={t('checkAuthoring.sectionHeading')} value={section.heading} disabled={locked}
          onChange={heading => setSection(s, current => ({ ...current, heading }))} />
        {section.blocks.map((block, b) => <div key={b} className="pl-2 border-l border-border">
          {block.kind === 'text' ? <TextField id={`outline-${s}-${b}`} label={t('checkAuthoring.textBlock')} value={block.text} disabled={locked} multiline
            onChange={text => setSection(s, current => ({ ...current, blocks: current.blocks.map((item, i) => i === b ? { ...block, text } : item) }))} />
            : block.kind === 'validationTable' ? <LiveTable block={block} evidence={evidence} />
              : <p className="text-muted-foreground">{t(block.kind === 'pageBreak' ? 'checkAuthoring.pageBreak' : 'checkAuthoring.validationSummary')}</p>}
        </div>)}
      </li>)}
    </ol>
    <UnsupportedList items={outline.unsupported} />
    {prepared.error && <Notice tone="error">{prepared.error}</Notice>}
    {!savedId && <Button size="sm" className="h-7" disabled={!prepared.draft || locked} onClick={() => void save()}>
      <Save className="h-3 w-3 mr-1" />{t('checkAuthoring.saveDocument')}</Button>}
    {savedId && <Notice tone="success">
      <p>{t('checkAuthoring.documentSaved')}</p>
      <Button size="sm" variant="outline" className="h-7" onClick={() => { setActiveDocumentId(savedId); panels.openInHome('document'); }}>
        {t('checkAuthoring.openDocument')}</Button>
    </Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <ContentStorageNotice status={storage} retry={retrySave} restore={restore} />
  </ReviewCard>;
}
