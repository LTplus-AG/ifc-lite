/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One block's editor (#4594). A text block is a template: "Insert field"
 * drops a `{path}` at the caret — the model's project, site, storeys, the
 * selected element's attributes and properties — and the bindings resolve
 * live in the preview. Image, chart and topic blocks pick their source.
 */
import { BlockTitleEditor } from './BlockTitleEditor';
import { isSavedComparisonChart } from '@/lib/charts/comparison-source';
import { SavedReportSource } from './SavedReportSource';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { ChartSpec } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import type { ValidationReport } from '@ifc-lite/ids';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import { CHART_FONT_SIZE } from '@ifc-lite/charts';
import { readImageFile } from '@/lib/document/persistence';
import type { BindingContext } from '@/lib/document/bindings';
import { idsReportBlockFromReport } from '@/lib/document/ids-report';
import { TAB_SIZE, tabEdit } from '@/lib/document/text-tabs';
import { CHART_BLOCK_HEIGHT_MAX, CHART_BLOCK_HEIGHT_MIN, TEXT_SIZE_MAX, TEXT_SIZE_MIN, reportBlockSourceKind, type DocumentBlock, type IdsReportBlock, type IdsReportVariant, type TextBlock, type TextFont } from '@/lib/document/types';
import { BlockScaleEditor, ClampedNumberInput, WidthEditor, field } from './BlockEditor.parts';
import { TableBlockEditor } from './TableBlockEditor';
import { ManualReportBlockEditor, ManualReportPresentation } from './ManualReportBlockEditor';
import { TextColorEditor } from './TextColorEditor';
import { FieldPicker } from './FieldPicker';

export interface BlockEditorProps {
  block: DocumentBlock;
  index: number;
  count: number;
  bindings: BindingContext;
  topics: Map<string, BCFTopic>;
  /** Every chart of every saved dashboard, to copy into a chart block. */
  charts: Array<{ dashboard: string; chart: ChartSpec }>;
  /** The live IDS/rule-set report an `ids-report` block can refresh its snapshot from. */
  idsValidationReport: ValidationReport | null;
  onChange: (block: DocumentBlock) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

const KIND_LABEL_KEY = {
  text: 'document.block.kindText',
  image: 'document.block.kindImage',
  chart: 'document.block.kindChart',
  topic: 'document.block.kindTopic',
  spacer: 'document.block.kindSpacer',
  'page-break': 'document.block.kindPageBreak',
  table: 'document.block.kindTable',
  'ids-report': 'document.block.kindIdsReport',
  'manual-report': 'manualValidation.report.kind',
} as const satisfies Record<DocumentBlock['kind'], TranslationKey>;

/**
 * A report block's source line and refresh button (#5125). IDS and information
 * validation share one report slot in the store, so refresh only takes a report
 * of the kind the block already holds (#6372): an IDS block never silently
 * turns into a rule-set block, or back.
 */
function ReportBlockSource({ block, report, onChange }: { block: IdsReportBlock; report: ValidationReport | null; onChange: (block: DocumentBlock) => void }) {
  const { t } = useTranslation();
  const kind = reportBlockSourceKind(block);
  const refreshable = report !== null && report.source.kind === kind;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-muted-foreground">{t('document.block.idsReportSourceLabel')}
        <span className="min-w-0 truncate font-medium text-foreground" title={block.sourceName}>{block.sourceName}</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-6 w-fit px-2 text-xs"
        disabled={!refreshable}
        title={refreshable ? undefined : t(kind === 'rules' ? 'document.block.rulesReportRefreshDisabledTitle' : 'document.block.idsReportRefreshDisabledTitle')}
        onClick={() => {
          if (!report || report.source.kind !== kind) return;
          onChange({ ...idsReportBlockFromReport(report, block.id, block.variant), title: block.title, benchmarks: block.benchmarks, specificationsOnly: block.specificationsOnly, scale: block.scale });
          toast.success(t('document.block.idsReportRefreshed'));
        }}
      >
        {t('document.block.idsReportRefresh')}
      </Button>
    </div>
  );
}

/** Presentation belongs to the embedded result, independently of live refresh (#6500). */
function ReportBlockPresentation({ block, onChange }: { block: IdsReportBlock; onChange: (block: DocumentBlock) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.idsReportVariantLabel')}
        <select
          className={field}
          value={block.variant ?? ''}
          onChange={(e) => onChange({ ...block, variant: (e.target.value || undefined) as IdsReportVariant | undefined })}
          aria-label={t('document.block.idsReportVariantAriaLabel')}
        >
          {block.variant === undefined && <option value="">{t('document.block.idsReportVariantClassic')}</option>}
          <option value="compact">{t('document.block.idsReportVariantCompact')}</option>
          <option value="long">{t('document.block.idsReportVariantLong')}</option>
        </select>
      </label>
      {block.variant === 'compact' && (
        <label className="inline-flex items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={block.specificationsOnly === true} onChange={(event) => onChange({ ...block, specificationsOnly: event.target.checked || undefined })} />
          {t('document.block.idsReportSpecificationsOnly')}
        </label>
      )}
      <label className="inline-flex items-center gap-1 text-muted-foreground">
        <input type="checkbox" checked={block.benchmarks === true} onChange={(event) => onChange({ ...block, benchmarks: event.target.checked })} />
        {t('manualValidation.report.benchmarks')}
      </label>
    </>
  );
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

function TextEditor({ block, bindings, onChange }: { block: TextBlock; bindings: BindingContext; onChange: (b: TextBlock) => void }) {
  const { t } = useTranslation();
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const insert = (path: string): void => {
    const el = textarea.current;
    const start = el?.selectionStart ?? block.text.length;
    const end = el?.selectionEnd ?? block.text.length;
    const text = `${block.text.slice(0, start)}{${path}}${block.text.slice(end)}`;
    onChange({ ...block, text });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + path.length + 2, start + path.length + 2); });
  };
  // Tab indents like a word processor (#6370). So the keyboard is never trapped in the box,
  // Escape arms an exit: the next Tab (or Shift+Tab) moves focus as usual. The hint under the
  // box says so, and any other key disarms it.
  const hintId = useId();
  const tabExitArmed = useRef(false);
  const pendingSelection = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    pendingSelection.current = null;
    if (selection) textarea.current?.setSelectionRange(selection[0], selection[1]);
  }, [block.text]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // A modifier on its own (the Shift of Esc, Shift+Tab) neither arms nor disarms the exit.
    if (MODIFIER_KEYS.has(event.key)) return;
    const armed = tabExitArmed.current;
    tabExitArmed.current = event.key === 'Escape';
    if (event.key !== 'Tab' || armed || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    const el = event.currentTarget;
    const edit = tabEdit(el.value, el.selectionStart, el.selectionEnd, event.shiftKey);
    // Shift+Tab with nothing left to outdent still stays in the box: one key, one meaning.
    event.preventDefault();
    if (!edit) return;
    pendingSelection.current = [edit.selectionStart, edit.selectionEnd];
    onChange({ ...block, text: edit.text });
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">{t('document.block.styleLabel')}
          <select className={field} value={block.style} onChange={(e) => onChange({ ...block, style: e.target.value as TextBlock['style'] })} aria-label={t('document.block.textStyleAriaLabel')}>
            <option value="title">{t('document.block.textStyleTitle')}</option><option value="heading">{t('document.block.textStyleHeading')}</option><option value="subheading">{t('document.block.textStyleSubheading')}</option>
            <option value="body">{t('document.block.textStyleBody')}</option><option value="small">{t('document.block.textStyleSmall')}</option><option value="caption">{t('document.block.textStyleCaption')}</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">{t('document.block.fontLabel')}
          <select className={field} value={block.font ?? 'helvetica'} onChange={(e) => onChange({ ...block, font: e.target.value as TextFont })} aria-label={t('document.block.fontAriaLabel')}>
            <option value="helvetica">{t('document.block.fontHelvetica')}</option><option value="times">{t('document.block.fontTimes')}</option><option value="courier">{t('document.block.fontCourier')}</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">{t('document.block.fontSizeLabel')}
          <ClampedNumberInput value={block.fontSize} min={TEXT_SIZE_MIN} max={TEXT_SIZE_MAX} allowUndefined placeholder={t('document.block.fontSizeDefault')} ariaLabel={t('document.block.fontSizeAriaLabel')} onCommit={(fontSize) => onChange({ ...block, fontSize })} />
        </label>
        <WidthEditor width={block.width} onChange={(width) => onChange({ ...block, width })} />
        <FieldPicker bindings={bindings} onInsert={insert} />
      </div>
      <TextColorEditor block={block} onChange={onChange} />
      <textarea
        ref={textarea}
        className={`${field} min-h-[56px] w-full font-mono`}
        style={{ tabSize: TAB_SIZE }}
        value={block.text}
        rows={block.style === 'body' ? 4 : 2}
        onChange={(e) => onChange({ ...block, text: e.target.value })}
        onKeyDown={onKeyDown}
        onBlur={() => { tabExitArmed.current = false; }}
        aria-label={t('document.block.textAriaLabel')}
        aria-describedby={hintId}
        placeholder={t('document.block.textPlaceholder')}
      />
      <p id={hintId} className="text-2xs text-muted-foreground">{t('document.block.textKeysHint')}</p>
    </>
  );
}

export function BlockEditor({ block, index, count, bindings, topics, charts, idsValidationReport, onChange, onMove, onRemove }: BlockEditorProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const pickImage = async (file: File | undefined): Promise<void> => {
    if (!file || block.kind !== 'image') return;
    setBusy(true);
    try {
      onChange({ ...block, dataUrl: await readImageFile(file) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('document.block.imageReadError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2 text-xs" data-block-editor={block.id} data-block-kind={block.kind}>
      <div className="flex items-center gap-1">
        <span className="font-medium">{t(block.kind === 'ids-report' && reportBlockSourceKind(block) === 'rules' ? 'document.block.kindRulesReport' : KIND_LABEL_KEY[block.kind])}</span>
        <span className="text-muted-foreground">#{index + 1}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t('document.block.moveUpAriaLabel')}><ArrowUp className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={t('document.block.moveDownAriaLabel')}><ArrowDown className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onRemove} aria-label={t('document.block.removeAriaLabel')}><X className="h-3.5 w-3.5" /></Button>
      </div>

      {block.kind !== 'table' && block.kind !== 'spacer' && block.kind !== 'page-break' && <BlockTitleEditor block={block} onChange={onChange} />}

      {block.kind !== 'spacer' && block.kind !== 'page-break' && <BlockScaleEditor scale={block.scale} onChange={(scale) => onChange({ ...block, scale })} />}

      {block.kind === 'text' && <TextEditor block={block} bindings={bindings} onChange={onChange} />}

      {block.kind === 'image' && (
        <>
          <div className="flex items-center gap-2">
            {block.dataUrl ? <img src={block.dataUrl} alt="" className="h-10 rounded border border-border object-contain" /> : <span className="text-muted-foreground">{t('document.block.imageEmpty')}</span>}
            <label className="cursor-pointer rounded border border-border px-2 py-0.5 hover:bg-accent">
              {busy ? t('document.block.imageReading') : t('document.block.imageChoosePrompt')}
              <input type="file" accept="image/png,image/jpeg" className="hidden" data-image-input onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.heightPtLabel')}
              <input type="number" min={20} max={600} className={`${field} w-16`} value={block.height} onChange={(e) => onChange({ ...block, height: Math.max(20, Number(e.target.value) || 20) })} aria-label={t('document.block.imageHeightAriaLabel')} />
            </label>
            <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.alignLabel')}
              <select className={field} value={block.align} onChange={(e) => onChange({ ...block, align: e.target.value as 'left' | 'center' | 'right' })} aria-label={t('document.block.imageAlignAriaLabel')}>
                <option value="left">{t('document.block.alignLeft')}</option><option value="center">{t('document.block.alignCenter')}</option><option value="right">{t('document.block.alignRight')}</option>
              </select>
            </label>
            <input className={`${field} flex-1`} value={block.caption ?? ''} placeholder={t('document.block.captionPlaceholder')} onChange={(e) => onChange({ ...block, caption: e.target.value || undefined })} aria-label={t('document.block.imageCaptionAriaLabel')} />
            <WidthEditor width={block.width} onChange={(width) => onChange({ ...block, width })} />
          </div>
        </>
      )}

      {block.kind === 'chart' && (
        <div className="flex flex-wrap items-center gap-2">
          {/* `basis-48` (12rem) is the label's own floor: with `flex-1` alone its basis is 0, so in this wrapping row it never
              wraps to a new line and the picker gets only what the sibling controls leave over, which can be ~0 (#6629). */}
          <label className="inline-flex min-w-0 basis-48 grow items-center gap-1 text-muted-foreground">{t('document.block.kindChart')}
            <select
              className={`${field} min-w-0 flex-1`}
              value=""
              onChange={(e) => {
                const pick = charts[Number(e.target.value)];
                if (pick) onChange({ ...block, chart: { ...pick.chart, id: block.chart.id } });
              }}
              aria-label={t('document.block.chartSelectAriaLabel')}
              title={t('document.block.chartSelectTitle')}
            >
              <option value="">{t('document.block.chartReplaceOption', { title: block.chart.title })}</option>
              {charts.map((c, i) => <option key={`${c.dashboard}:${c.chart.id}`} value={i}>{c.dashboard} › {c.chart.title}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={block.snapshot && !isSavedComparisonChart(block.chart)} disabled={isSavedComparisonChart(block.chart)} onChange={(e) => onChange({ ...block, snapshot: e.target.checked })} className="accent-[#7aa2f7]" /> {t('document.block.chartSnapshotLabel')}
          </label>
          <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.heightPtLabel')}
            <ClampedNumberInput
              value={block.height}
              min={CHART_BLOCK_HEIGHT_MIN}
              max={CHART_BLOCK_HEIGHT_MAX}
              placeholder="220"
              allowUndefined
              ariaLabel={t('document.block.chartHeightAriaLabel')}
              onCommit={(height) => onChange({ ...block, height })}
            />
          </label>
          <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.chartFontSizeLabel')}
            <ClampedNumberInput value={block.fontSize} min={CHART_FONT_SIZE.min} max={CHART_FONT_SIZE.max}
              placeholder={String(CHART_FONT_SIZE.default)} allowUndefined ariaLabel={t('document.block.chartFontSizeAriaLabel')}
              onCommit={(fontSize) => onChange({ ...block, fontSize })} />
          </label>
          <Button size="sm" variant="ghost" disabled={block.fontSize === undefined} onClick={() => onChange({ ...block, fontSize: undefined })}>
            {t('document.block.chartFontSizeReset')}
          </Button>
          <WidthEditor width={block.width} onChange={(width) => onChange({ ...block, width })} />
        </div>
      )}

      {block.kind === 'spacer' && (
        <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.heightPtLabel')}
          <ClampedNumberInput value={block.height} min={4} max={400} ariaLabel={t('document.block.spacerHeightAriaLabel')} onCommit={(height) => onChange({ ...block, height: height ?? 4 })} />
        </label>
      )}

      {block.kind === 'table' && <TableBlockEditor block={block} onChange={onChange} />}

      {(block.kind === 'ids-report' || block.kind === 'manual-report') && <SavedReportSource block={block} onChange={onChange} />}
      {block.kind === 'ids-report' && <ReportBlockPresentation block={block} onChange={onChange} />}
      {block.kind === 'ids-report' && !block.savedReportId && <ReportBlockSource block={block} report={idsValidationReport} onChange={onChange} />}

      {block.kind === 'manual-report' && <ManualReportPresentation block={block} onChange={onChange} />}
      {block.kind === 'manual-report' && !block.savedReportId && <ManualReportBlockEditor block={block} onChange={onChange} />}

      {block.kind === 'topic' && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">{t('document.block.topicSourceLabel')}
            <select className={`${field} min-w-0 flex-1`} value={block.guid} onChange={(e) => onChange({ ...block, guid: e.target.value })} aria-label={t('document.block.kindTopic')}>
              {!topics.has(block.guid) && <option value={block.guid}>{block.guid ? t('document.block.topicNotLoaded', { guid: block.guid }) : t('document.block.pickTopicOption')}</option>}
              {[...topics.values()].map((topic) => <option key={topic.guid} value={topic.guid}>{topic.title}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={block.snapshot} onChange={(e) => onChange({ ...block, snapshot: e.target.checked })} className="accent-[#7aa2f7]" /> {t('document.block.topicSnapshotLabel')}
          </label>
        </div>
      )}
    </div>
  );
}
