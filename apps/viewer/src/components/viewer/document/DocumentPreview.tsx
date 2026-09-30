/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The document as a page (#4594): every block resolved against the loaded
 * model, on a white sheet in the page's proportions. Charts are the same
 * SSR SVG the PDF gets; an unresolved binding is marked in place, never
 * printed as an empty string.
 */
import { blockTitle, BLOCK_TITLE_HEIGHT } from '@/lib/document/block-title';
import { useMemo, useState } from 'react';
import { chartFontScale, renderChartSvg, type Aggregation } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import { useTranslation } from '@/i18n';
import { renderTemplate, type BindingContext } from '@/lib/document/bindings';
import { REPORT_THEME } from '@/lib/export/report/generate-report-pdf';
import { topicLines, topicSnapshotDataUrl } from '@/lib/document/generate-document-pdf';
import { pageBox, REPORT_MARGIN } from '@/lib/export/report/compose';
import { BLOCK_GAP, documentChartSizing, documentImageHeight, halfTextFitsPage, TEXT_STYLES } from '@/lib/document/compose';
import { CHART_BLOCK_HEIGHT_DEFAULT, isHalfPairable, type DocumentBlock, type DocumentSpec, type TextBlock } from '@/lib/document/types';
import type { TableState } from '@/lib/document/resolve-table';
import { TAB_SIZE } from '@/lib/document/text-tabs';
import { splitDocumentSections } from '@/lib/document/page-sections';
import { DOCUMENT_PREVIEW_MUTED_TEXT_CLASS, DOCUMENT_PREVIEW_PAPER_CLASS } from './preview-theme';
import { TablePreview } from './TablePreview';
import { IdsReportPreview } from './IdsReportPreview';
import { ManualReportPreview } from './ManualReportPreview';

export interface DocumentPreviewProps {
  document: DocumentSpec;
  bindings: BindingContext;
  aggregations: Map<string, Aggregation | null>;
  /** A chart block's filter-resolution message (#4946), when its filter is
   *  still resolving or was refused — shown instead of "No data". */
  chartMessages: Map<string, string>;
  topics: Map<string, BCFTopic>;
  /** Table block id → its list run (#5142). Optional so callers without table blocks need not build one. */
  tables?: ReadonlyMap<string, TableState>;
  selectedBlockId: string | null;
  onSelectBlock: (id: string) => void;
}

const TEXT_CLASS: Record<TextBlock['style'], string> = {
  title: 'text-2xl font-semibold leading-tight',
  heading: 'text-base font-semibold mt-2',
  subheading: 'text-sm font-semibold mt-1',
  body: 'text-sm leading-relaxed',
  small: 'text-2xs leading-relaxed',
  caption: 'text-2xs text-neutral-500',
};

/** Consecutive text/chart/image blocks both at `width: 'half'` render two-up (#4940). */
function groupBlocks(blocks: readonly DocumentBlock[], bindings: BindingContext, pageHeight: number, contentWidth: number): Array<DocumentBlock | [DocumentBlock, DocumentBlock]> {
  const groups: Array<DocumentBlock | [DocumentBlock, DocumentBlock]> = [];
  const colW = (contentWidth - BLOCK_GAP) / 2;
  const fits = (block: DocumentBlock): boolean => block.kind !== 'text' || halfTextFitsPage({ ...block, text: renderTemplate(block.text, bindings).text }, pageHeight, colW);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const next = blocks[i + 1];
    if (isHalfPairable(block) && next && isHalfPairable(next) && fits(block) && fits(next)) {
      groups.push([block, next]);
      i += 1;
    } else {
      groups.push(block);
    }
  }
  return groups;
}

/** A template with its placeholders resolved; unresolved ones are marked so the author sees them. */
function ResolvedText({ text, bindings }: { text: string; bindings: BindingContext }) {
  const parts = useMemo(() => {
    const out: Array<{ text: string; unresolved: boolean; title?: string }> = [];
    let last = 0;
    for (const m of text.matchAll(/\{([^{}]+)\}/g)) {
      if (m.index > last) out.push({ text: text.slice(last, m.index), unresolved: false });
      const rendered = renderTemplate(m[0], bindings);
      const binding = rendered.bindings[0];
      out.push({ text: rendered.text, unresolved: !binding?.ok, title: binding?.ok ? `{${binding.path}}` : binding?.reason });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), unresolved: false });
    return out;
  }, [text, bindings]);
  return (
    <>
      {parts.map((p, i) => (p.unresolved
        ? <mark key={i} className="rounded bg-amber-200/70 px-0.5 text-amber-950" title={p.title} data-unresolved>{p.text}</mark>
        : <span key={i} title={p.title} className={p.title ? 'rounded bg-sky-100/70 px-0.5' : undefined}>{p.text}</span>))}
    </>
  );
}

function ChartSvg({ aggregation, message, width, height, fontSize, scale }: { aggregation: Aggregation | null; message: string | undefined; width: number; height: number; fontSize?: number; scale: number }) {
  const { t } = useTranslation();
  // Custom typography uses the PDF's point-space layout, then scales the whole
  // vector to the sheet. Keep the established default preview unchanged (#6546).
  const renderScale = chartFontScale(fontSize) === 1 ? 1 : scale;
  const svg = useMemo(() => (aggregation && aggregation.categories.length > 0
    ? renderChartSvg({ aggregation, width: width / renderScale, height: height / renderScale, fontSize, theme: REPORT_THEME, showTitle: false, print: true })
    : null), [aggregation, width, height, fontSize, renderScale]);
  if (!svg) {
    return (
      <div className="flex items-center justify-center rounded border border-dashed border-neutral-300 px-3 text-center text-xs text-neutral-500" style={{ height: Math.max(48, height) }} data-chart-empty>
        {message ?? t('document.preview.chartEmpty')}
      </div>
    );
  }
  // The SVG string is ECharts' own output over data we aggregated; nothing user-authored is in it.
  return <div className={`w-full overflow-hidden${renderScale === 1 ? '' : ' [&_svg]:h-auto [&_svg]:w-full'}`} dangerouslySetInnerHTML={{ __html: svg }} data-chart-svg />;
}

/** Mirrors PDF image sizing once the browser has measured the data URL's intrinsic ratio. */
function PreviewImage({ dataUrl, alt, height, contentWidth }: { dataUrl: string; alt: string; height: number; contentWidth: number }) {
  const [aspect, setAspect] = useState<number | null>(null);
  const drawnHeight = aspect && aspect > 0 ? Math.min(height, contentWidth / aspect) : height;
  return <img src={dataUrl} alt={alt} style={{ height: drawnHeight, maxWidth: contentWidth }} className="w-auto object-contain" onLoad={(event) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (naturalWidth > 0 && naturalHeight > 0) setAspect(naturalWidth / naturalHeight);
  }} />;
}

function Block({ block, bindings, aggregation, chartMessage, topic, table, contentWidth, scale, pageHeight }: { block: DocumentBlock; bindings: BindingContext; aggregation: Aggregation | null; chartMessage: string | undefined; topic: BCFTopic | undefined; table: TableState | undefined; contentWidth: number; scale: number; pageHeight: number }) {
  const { t } = useTranslation();
  switch (block.kind) {
    case 'text':
      // Every style keeps the text as typed, like the PDF's `wrapText` (#6370): line breaks,
      // tab indents (same tab stop as the PDF) and runs of spaces. Title, heading and subheading
      // once collapsed a typed line break into a space.
      return <div>{blockTitle(block) && <div className="truncate font-semibold" style={{ fontSize: 11 * scale, height: BLOCK_TITLE_HEIGHT * scale }} title={blockTitle(block)}>{blockTitle(block)}</div>}
        <div className={TEXT_CLASS[block.style]} style={{ color: block.textColor, backgroundColor: block.backgroundColor, whiteSpace: 'pre-wrap', tabSize: TAB_SIZE, fontSize: (block.fontSize ?? TEXT_STYLES[block.style].size) * scale, fontFamily: block.font === 'times' ? 'Times New Roman, serif' : block.font === 'courier' ? 'Courier New, monospace' : 'Helvetica, Arial, sans-serif' }} data-block-text>{block.text.trim() ? <ResolvedText text={block.text} bindings={bindings} /> : <span className={DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}>{t('document.preview.textEmpty')}</span>}</div></div>;

    case 'image': {
      const title = blockTitle(block);
      const height = (title ? documentImageHeight(block, pageHeight) : block.height) * scale;
      const justify = block.align === 'left' ? 'justify-start' : block.align === 'right' ? 'justify-end' : 'justify-center';
      return (
        <figure className={`flex flex-col ${block.align === 'center' ? 'items-center' : block.align === 'right' ? 'items-end' : 'items-start'}`}>
          {title && <div className="w-full truncate font-semibold" style={{ fontSize: 11 * scale, height: BLOCK_TITLE_HEIGHT * scale }} title={title}>{title}</div>}
          <div className={`flex w-full ${justify}`}>
            {block.dataUrl
              ? <PreviewImage key={block.dataUrl} dataUrl={block.dataUrl} alt={block.caption ?? ''} height={height} contentWidth={contentWidth} />
              : <div className="flex items-center justify-center rounded border border-dashed border-neutral-300 px-3 text-xs text-neutral-500" style={{ height, minWidth: 80 }}>{t('document.preview.imageEmpty')}</div>}
          </div>
          {block.caption && <figcaption className="text-2xs text-neutral-500">{block.caption}</figcaption>}
        </figure>
      );
    }
    case 'chart': {
      const textScale = chartFontScale(block.fontSize);
      const { height: chartHeight } = documentChartSizing({
        requestedHeight: block.height ?? CHART_BLOCK_HEIGHT_DEFAULT,
        pageHeight,
        boxWidth: contentWidth / scale,
        snapshot: block.snapshot,
        hasData: Boolean(aggregation && aggregation.categories.length > 0),
        fontSize: block.fontSize,
      });
      const height = chartHeight * scale;
      // Computed once, not repeated as a JSX-expression literal in both the visible text and its
      // `title` tooltip (i18n literal-count gate: a duplicated inline ternary counts twice).
      const chartSubtitle = chartMessage ?? (aggregation ? `${aggregation.categories.length} bucket${aggregation.categories.length === 1 ? '' : 's'} · ${aggregation.total.toLocaleString()}` : 'No data');
      const subtitle = `${chartSubtitle}${block.snapshot ? ' · 3D snapshot in the PDF' : ''}`;
      return (
        <div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold" title={blockTitle(block, block.chart.title)} style={textScale === 1 ? undefined : { fontSize: 11 * textScale * scale, lineHeight: `${16 * textScale * scale}px` }}>{blockTitle(block, block.chart.title)}</div>
            <div className="truncate text-2xs text-neutral-500" title={subtitle} style={textScale === 1 ? undefined : { fontSize: 8 * textScale * scale, lineHeight: `${16 * textScale * scale}px` }}>{subtitle}</div>
          </div>
          <ChartSvg aggregation={aggregation} message={chartMessage} width={contentWidth} height={height} fontSize={block.fontSize} scale={scale} />
        </div>
      );
    }
    case 'page-break': return null;
    case 'spacer':
      // The flex column's own `gap-2.5` (10px) already sits on both sides of this block, but
      // compose.ts (and every other block here) only ever adds one trailing gap per block — a
      // spacer effectively double-counted one, pushing everything after it lower than the PDF
      // does (review finding). A negative margin cancels the container's second gap.
      return <div style={{ height: block.height * scale, marginBottom: '-0.625rem' }} data-block-spacer />;
    case 'table':
      return <TablePreview block={block} state={table} />;
    case 'ids-report':
      return <IdsReportPreview block={block} />;
    case 'manual-report':
      return <ManualReportPreview block={block} />;
    case 'topic': {
      if (!topic) return <div>{blockTitle(block) && <div className="truncate text-sm font-semibold">{blockTitle(block)}</div>}<div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900" data-unresolved>{t('document.preview.topicNotLoaded', { guid: block.guid })}</div></div>;
      const snapshot = block.snapshot ? topicSnapshotDataUrl(topic) : null;
      return (
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <div className={`${blockTitle(block) ? 'truncate ' : ''}text-sm font-semibold`} title={blockTitle(block) || undefined}>{blockTitle(block, topic.title)}</div>
            {topicLines(topic).map((line, i) => <div key={i} className="text-xs text-neutral-700">{line}</div>)}
          </div>
          {snapshot && <img src={snapshot} alt="" className="h-28 rounded border border-neutral-200 object-cover" />}
        </div>
      );
    }
  }
}

export function DocumentPreview({ document, bindings, aggregations, chartMessages, topics, tables, selectedBlockId, onSelectBlock }: DocumentPreviewProps) {
  const { t } = useTranslation();
  const size = pageBox(document.page);
  // The sheet scales to the panel; block content is laid out at this width.
  const width = 560;
  const contentWidth = width * (1 - 80 / size.w);
  // px-per-pt for the whole sheet, independent of page orientation and of any one block's column
  // width — a height in points (chart, image, spacer) converts through this, never through
  // `contentWidth`, which is narrower than the page for a half-width column (review finding: a
  // landscape or half-width block was rendered off the PDF's actual scale).
  const scale = width / size.w;
  const sections = splitDocumentSections(document.blocks);
  return (
    <div className="flex flex-col items-center gap-4 p-3" data-document-preview>
      {sections.map((blocks, pageIndex) => <section
        key={blocks[0]?.id ?? 'empty'}
        data-preview-section={pageIndex + 1}
        aria-label={t('document.preview.sectionLabel', { section: String(pageIndex + 1) })}
        className={`${DOCUMENT_PREVIEW_PAPER_CLASS} shadow-md`}
        style={{ width, minHeight: width * (size.h / size.w), padding: `${(40 / size.w) * width}px`, fontFamily: 'Helvetica, Arial, sans-serif' }}
      >
        <div className={`mb-3 text-2xs ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>{document.name}</div>
        <div className="flex flex-col gap-2.5">
          {groupBlocks(blocks, bindings, size.h, size.w - 2 * REPORT_MARGIN).map((group) => {
            const wrap = (block: DocumentBlock) => (
              /* DocumentBlock renders figures and divs, which cannot be nested in a button. */
              // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
              <div role="button"
                key={block.id}
                aria-label={block.kind === 'spacer' ? t('document.addBlock.spacer') : block.kind === 'image' && !block.caption ? t('document.addBlock.image') : undefined}
                tabIndex={0}
                className={`-mx-1 cursor-pointer rounded px-1 ring-offset-1 hover:ring-1 hover:ring-sky-300 ${selectedBlockId === block.id ? 'ring-1 ring-sky-500' : ''}`}
                onClick={() => onSelectBlock(block.id)}
                onKeyDown={(event) => {
                  if (event.currentTarget === event.target && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onSelectBlock(block.id);
                  }
                }}
                data-preview-block={block.id}
              >
                <Block block={block} bindings={bindings} aggregation={aggregations.get(block.id) ?? null} chartMessage={chartMessages.get(block.id)} topic={block.kind === 'topic' ? topics.get(block.guid) : undefined} table={tables?.get(block.id)} contentWidth={Array.isArray(group) ? (contentWidth - BLOCK_GAP * scale) / 2 : contentWidth} scale={scale} pageHeight={size.h} />
              </div>
            );
            return Array.isArray(group)
              ? <div key={group[0].id} className="grid grid-cols-2" style={{ gap: BLOCK_GAP * scale }} data-preview-row>{wrap(group[0])}{wrap(group[1])}</div>
              : wrap(group);
          })}
          {blocks.length === 0 && <div className={`text-xs ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>{t('document.preview.emptyPage')}</div>}
        </div>
      </section>)}
    </div>
  );
}
