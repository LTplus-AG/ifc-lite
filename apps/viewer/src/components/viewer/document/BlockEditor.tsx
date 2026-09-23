/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One block's editor (#4594). A text block is a template: "Insert field"
 * drops a `{path}` at the caret — the model's project, site, storeys, the
 * selected element's attributes and properties — and the bindings resolve
 * live in the preview. Image, chart and topic blocks pick their source.
 */
import { useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { ChartSpec } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import type { ValidationReport } from '@ifc-lite/ids';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import { resolveGlobalId, useViewerStore } from '@/store';
import { readImageFile } from '@/lib/document/persistence';
import { FIELD_SUGGESTIONS } from '@/lib/document/presets';
import { elementPropertyPaths, type BindingContext } from '@/lib/document/bindings';
import { idsReportBlockFromReport } from '@/lib/document/ids-report';
import { CHART_BLOCK_HEIGHT_MAX, CHART_BLOCK_HEIGHT_MIN, TEXT_SIZE_MAX, TEXT_SIZE_MIN, type DocumentBlock, type TextBlock, type TextFont } from '@/lib/document/types';
import { ClampedNumberInput, WidthEditor, field } from './BlockEditor.parts';
import { TableBlockEditor } from './TableBlockEditor';

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
  table: 'document.block.kindTable',
  'ids-report': 'document.block.kindIdsReport',
} as const satisfies Record<DocumentBlock['kind'], TranslationKey>;
/** The fields offered for insertion: the fixed suggestions, the model's storeys, and the selected element. */
function useFieldOptions(bindings: BindingContext): Array<{ path: string; label: string }> {
  const selected = useViewerStore((s) => s.selectedEntityIds);
  return useMemo(() => {
    const options = [...FIELD_SUGGESTIONS];
    const active = bindings.models.find((m) => m.id === bindings.activeModelId) ?? bindings.models[0];
    const storeys = active?.store.spatialHierarchy ? [...active.store.spatialHierarchy.byStorey.keys()] : [];
    for (const id of storeys.slice(0, 12)) {
      const name = active.store.entities.getName(id);
      if (name) options.push({ path: `IfcBuildingStorey["${name}"].Elevation`, label: `Storey "${name}" elevation` });
    }
    const first = selected.size > 0 ? [...selected][0] : null;
    // The store's own renderer-id → GlobalId path, so an element added by an edit resolves too.
    const guid = first === null ? null : resolveGlobalId(first);
    if (guid) {
      for (const attr of ['Name', 'Type', 'Description', 'ObjectType', 'Tag', 'Storey']) options.push({ path: `Element[${guid}].${attr}`, label: `Selected element · ${attr}` });
      // The selected element's property and quantity sets, so a Pset value is one pick away.
      for (const p of elementPropertyPaths(guid, bindings)) options.push({ path: p.path, label: `Selected element · ${p.label}` });
    }
    return options;
  }, [bindings, selected]);
}

function TextEditor({ block, bindings, onChange }: { block: TextBlock; bindings: BindingContext; onChange: (b: TextBlock) => void }) {
  const { t } = useTranslation();
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const options = useFieldOptions(bindings);
  const insert = (path: string): void => {
    const el = textarea.current;
    const start = el?.selectionStart ?? block.text.length;
    const end = el?.selectionEnd ?? block.text.length;
    const text = `${block.text.slice(0, start)}{${path}}${block.text.slice(end)}`;
    onChange({ ...block, text });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + path.length + 2, start + path.length + 2); });
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
            <option value="helvetica">Helvetica</option><option value="times">Times</option><option value="courier">Courier</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">{t('document.block.fontSizeLabel')}
          <ClampedNumberInput value={block.fontSize} min={TEXT_SIZE_MIN} max={TEXT_SIZE_MAX} allowUndefined placeholder={t('document.block.fontSizeDefault')} ariaLabel={t('document.block.fontSizeAriaLabel')} onCommit={(fontSize) => onChange({ ...block, fontSize })} />
        </label>
        <WidthEditor width={block.width} onChange={(width) => onChange({ ...block, width })} />
        <label className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap text-muted-foreground">{t('document.block.insertFieldLabel')}
          <select className={`${field} max-w-[190px]`} value="" onChange={(e) => { if (e.target.value) insert(e.target.value); }} aria-label={t('document.block.insertFieldLabel')} title={t('document.block.insertFieldTitle')}>
            <option value="">…</option>
            {options.map((o) => <option key={o.path} value={o.path}>{o.label}</option>)}
          </select>
        </label>
      </div>
      <textarea
        ref={textarea}
        className={`${field} min-h-[56px] w-full font-mono`}
        value={block.text}
        rows={block.style === 'body' ? 4 : 2}
        onChange={(e) => onChange({ ...block, text: e.target.value })}
        aria-label={t('document.block.textAriaLabel')}
        placeholder={t('document.block.textPlaceholder')}
      />
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
        <span className="font-medium">{t(KIND_LABEL_KEY[block.kind])}</span>
        <span className="text-muted-foreground">#{index + 1}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t('document.block.moveUpAriaLabel')}><ArrowUp className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={t('document.block.moveDownAriaLabel')}><ArrowDown className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onRemove} aria-label={t('document.block.removeAriaLabel')}><X className="h-3.5 w-3.5" /></Button>
      </div>

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
          <label className="inline-flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">{t('document.block.kindChart')}
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
            <input type="checkbox" checked={block.snapshot} onChange={(e) => onChange({ ...block, snapshot: e.target.checked })} className="accent-[#7aa2f7]" /> {t('document.block.chartSnapshotLabel')}
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
          <WidthEditor width={block.width} onChange={(width) => onChange({ ...block, width })} />
        </div>
      )}

      {block.kind === 'spacer' && (
        <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.heightPtLabel')}
          <ClampedNumberInput value={block.height} min={4} max={400} ariaLabel={t('document.block.spacerHeightAriaLabel')} onCommit={(height) => onChange({ ...block, height: height ?? 4 })} />
        </label>
      )}

      {block.kind === 'table' && <TableBlockEditor block={block} onChange={onChange} />}

      {block.kind === 'ids-report' && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1 text-muted-foreground">{t('document.block.idsReportSourceLabel')}
            <span className="min-w-0 truncate font-medium text-foreground" title={block.sourceName}>{block.sourceName}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-6 w-fit px-2 text-xs"
            disabled={!idsValidationReport}
            title={idsValidationReport ? undefined : t('document.block.idsReportRefreshDisabledTitle')}
            onClick={() => {
              if (!idsValidationReport) return;
              onChange(idsReportBlockFromReport(idsValidationReport, block.id));
              toast.success(t('document.block.idsReportRefreshed'));
            }}
          >
            {t('document.block.idsReportRefresh')}
          </Button>
        </div>
      )}

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
