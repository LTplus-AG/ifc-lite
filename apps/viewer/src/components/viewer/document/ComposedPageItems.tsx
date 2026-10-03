/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import type { BCFTopic } from '@ifc-lite/bcf';
import { renderChartSvg, type Aggregation } from '@ifc-lite/charts';
import { REPORT_THEME } from '@/lib/export/report/generate-report-pdf';
import { chartSourceMessageLines } from '@/lib/export/report/render-source-message';
import { isSavedComparisonChart } from '@/lib/charts/comparison-source';
import type { ComposeDocumentInput, DocumentPage, DrawnItem } from '@/lib/document/compose';
import { TABLE_ROW_HEIGHT } from '@/lib/document/compose-table';
import { TEXT_STYLES } from '@/lib/document/compose-text';
import { DOCUMENT_FONT_FAMILIES } from '@/lib/document/text-typography';
import { tableHeaderStyle } from '@/lib/table-header-style';
import { topicSnapshotDataUrl } from '@/lib/document/generate-document-pdf';
import { ringSvg } from '@/lib/validation/manual/ring';
import { blockScale, type DocumentBlock } from '@/lib/document/types';
import type { DocumentLabelFormatter } from '@/lib/document/document-labels';
import type { PreviewImageSize } from './useDocumentLayout';
import { previewTextPaint } from './preview-theme';

interface Box { x: number; y: number; w: number; h: number }
interface BlockItems { id: string; items: DrawnItem[]; boxes: Box[] }
export interface ComposedPageItemsProps {
  page: DocumentPage;
  blocks: ReadonlyMap<string, DocumentBlock>;
  aggregations: ReadonlyMap<string, Aggregation | null>;
  chartMessages: ReadonlyMap<string, string>;
  topics: ReadonlyMap<string, BCFTopic>;
  scale: number;
  measure: ComposeDocumentInput['measure'];
  labels: DocumentLabelFormatter;
  selectedBlockId: string | null;
  onSelectBlock: (id: string) => void;
  onImageSize: (dataUrl: string, size: PreviewImageSize) => void;
  imageFailures: ReadonlySet<string>;
  onImageError: (dataUrl: string) => void;
}

function itemBox(item: DrawnItem, measure: ComposeDocumentInput['measure']): Box {
  if (item.kind === 'text') return { x: item.x, y: item.y - item.size, w: Math.max(4, measure(item.text, item.size, item.bold, item.font)), h: item.size * 1.25 };
  if (item.kind === 'ring') return { x: item.x, y: item.y, w: item.size, h: item.size };
  if (item.kind === 'table') return { x: item.x, y: item.y, w: item.w, h: TABLE_ROW_HEIGHT * (item.scale ?? 1) * (item.rows.length + 1) };
  return item;
}

function position(box: Box, origin: Box, scale: number): CSSProperties {
  return { position: 'absolute', left: (box.x - origin.x) * scale, top: (box.y - origin.y) * scale,
    width: box.w * scale, height: box.h * scale };
}

/** Retain the existing chart SSR cache when only block selection changes. */
function ComposedChart({ aggregation, item, fontSize, message, savedComparison, style, scale, measure }: {
  aggregation: Aggregation | null | undefined;
  item: Extract<DrawnItem, { kind: 'chart' }>;
  fontSize: number | undefined;
  message: string;
  savedComparison: boolean;
  style: CSSProperties;
  scale: number;
  measure: ComposeDocumentInput['measure'];
}) {
  const factor = item.scale ?? 1;
  const width = item.w / factor, height = item.h / factor;
  const svg = useMemo(() => aggregation && aggregation.categories.length > 0
    ? renderChartSvg({ aggregation, width, height, fontSize, theme: REPORT_THEME, showTitle: false, print: true })
    : null, [aggregation, width, height, fontSize]);
  if (svg) return <span style={style} className="block [&_svg]:h-full [&_svg]:w-full" data-chart-svg dangerouslySetInnerHTML={{ __html: svg }} />;
  const lines = savedComparison ? chartSourceMessageLines(message, item, 9, measure) : [{ text: message, y: 14 }];
  const paint = previewTextPaint(130);
  return <span style={{ ...style, overflow: 'hidden' }} title={message} data-chart-empty>
    {lines.map((line, i) => <span key={i} className={paint.className} style={{ position: 'absolute', left: 0, top: (line.y - 9) * scale,
      whiteSpace: 'pre', fontSize: 9 * scale, lineHeight: 1.25, color: paint.color }}>{line.text}{'\n'}</span>)}
  </span>;
}

function Item({ item, block, origin, props, lineBreak, children }: { item: DrawnItem; block: DocumentBlock; origin: Box; props: ComposedPageItemsProps; lineBreak: boolean; children?: ReactNode }) {
  const { scale, measure, labels: t } = props;
  const box = itemBox(item, measure);
  const style = position(box, origin, scale);
  const paint = item.kind === 'text' ? previewTextPaint(item.gray, item.color, block.kind === 'text' ? block.backgroundColor : undefined) : null;
  const markedText = () => {
    if (item.kind !== 'text' || !item.bindingMarks?.length) return item.kind === 'text' ? item.text : '';
    let end = 0;
    const nodes = item.bindingMarks.map((mark, index) => {
      const prefix = item.text.slice(end, mark.start);
      end = mark.end;
      const content = item.text.slice(mark.start, mark.end);
      return <span key={index}>{prefix}{mark.unresolved
        ? <mark data-unresolved title={mark.tooltip} className="bg-amber-200/70 text-amber-950">{content}</mark>
        : <span title={mark.tooltip} className="bg-sky-100/70">{content}</span>}</span>;
    });
    return <>{nodes}{item.text.slice(end)}</>;
  };
  switch (item.kind) {
    case 'text': return <span className={paint?.className} style={{ ...style, width: undefined, whiteSpace: 'pre', lineHeight: 1.25,
      fontSize: item.size * scale, fontFamily: DOCUMENT_FONT_FAMILIES[item.font ?? 'helvetica'],
      fontWeight: item.bold ? 700 : 400, color: paint?.color }}
      data-table-message={item.role === 'table-message' ? '' : undefined}
      data-report-model-scope={item.role === 'report-model-scope' ? '' : undefined} title={item.tooltip}>{markedText()}{lineBreak ? '\n' : ''}</span>;
    case 'rect':
    case 'text-background': return <span aria-hidden={children ? undefined : true} data-composed-fill={item.kind} style={{ ...style, backgroundColor: item.color }}>{children}</span>;
    case 'image':
    case 'topic-snapshot': {
      const topic = block.kind === 'topic' ? props.topics.get(block.guid) : undefined;
      const dataUrl = item.kind === 'image' && block.kind === 'image' ? block.dataUrl
        : topic ? topicSnapshotDataUrl(topic) : null;
      return dataUrl && !props.imageFailures.has(dataUrl) ? <img key={dataUrl} src={dataUrl} alt={block.kind === 'image' ? block.caption ?? '' : ''}
        style={{ ...style, objectFit: 'contain' }} onError={() => props.onImageError(dataUrl)} onLoad={event => {
          const { naturalWidth: w, naturalHeight: h } = event.currentTarget;
          if (w > 0 && h > 0) props.onImageSize(dataUrl, { w, h });
          else props.onImageError(dataUrl);
        }} /> : <span style={style} className="flex items-center justify-center border border-dashed border-neutral-300 text-xs text-neutral-500">{dataUrl ? t('document.print.imageError') : t('document.preview.imageEmpty')}</span>;
    }
    case 'chart': return <ComposedChart aggregation={props.aggregations.get(item.blockId)} item={item}
      fontSize={block.kind === 'chart' ? block.fontSize : undefined}
      message={props.chartMessages.get(item.blockId) ?? t('document.preview.chartEmpty')}
      savedComparison={block.kind === 'chart' && isSavedComparisonChart(block.chart)}
      style={style} scale={scale} measure={measure} />;
    case 'snapshot': return <span style={style} className="flex items-center justify-center border border-dashed border-neutral-300 text-xs text-neutral-500">{t('document.print.snapshot')}</span>;
    case 'ring': {
      const name = block.kind === 'manual-report' ? block.checklistName : block.kind === 'ids-report' ? block.sourceName : '';
      const description = item.counts.total === 0 ? t('manualValidation.ring.empty', { name })
        : t('manualValidation.ring.label', { name, ...item.counts });
      const alt = block.kind === 'ids-report' ? `${description} · ${t('document.preview.idsReportPassRate')} ${block.summary.passRate}%` : description;
      return <span style={style} data-manual-report-benchmarks={block.kind === 'manual-report' && item.role === 'overall' ? '' : undefined}
        data-validation-benchmark={block.kind === 'ids-report' ? '' : undefined}>
        <img src={`data:image/svg+xml,${encodeURIComponent(ringSvg(item.counts, item.size))}`} alt={alt} style={{ width: '100%', height: '100%' }} />
      </span>;
    }
    case 'table': {
      const palette = item.headerStyle ?? tableHeaderStyle();
      const tableScale = scale * (item.scale ?? 1);
      const cell: CSSProperties = { height: TABLE_ROW_HEIGHT * tableScale, padding: 2 * tableScale, boxSizing: 'border-box',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', border: '1px solid #e5e5e5' };
      return <table style={{ ...style, borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: 8 * tableScale, lineHeight: 1 }} data-table-rows={item.rows.length}>
        <colgroup>{item.columns.map((column, i) => <col key={i} style={{ width: column.width * scale }} />)}</colgroup>
        <thead><tr>{item.columns.map((column, i) => <th key={i} style={{ ...cell, textAlign: column.align,
          backgroundColor: palette.backgroundColor, color: palette.textColor }}>{column.label}</th>)}</tr></thead>
        <tbody>{item.rows.map((row, i) => <tr key={i} data-role={row.role} style={{
          backgroundColor: row.role === 'group' || row.role === 'total' ? '#f1f5f9' : undefined,
          fontWeight: row.role === 'group' || row.role === 'total' ? 700 : 400, fontStyle: row.role === 'more' ? 'italic' : undefined,
        }}>{row.cells.map((text, c) => <td key={c} title={text} style={{ ...cell, textAlign: item.columns[c]?.align }}>{text}</td>)}</tr>)}</tbody>
      </table>;
    }
  }
}

/** Draw only the items the existing composer assigned to this page. */
export function ComposedPageItems(props: ComposedPageItemsProps) {
  const groups = new Map<string, BlockItems>();
  const group = (id: string): BlockItems => {
    let value = groups.get(id);
    if (!value) { value = { id, items: [], boxes: [] }; groups.set(id, value); }
    return value;
  };
  props.page.items.forEach((item, index) => {
    const id = props.page.blockIds?.[index];
    if (!id) return;
    const value = group(id);
    value.items.push(item);
    value.boxes.push(itemBox(item, props.measure));
  });
  for (const box of props.page.emptyBlocks ?? []) group(box.blockId).boxes.push(box);
  return [...groups.values()].map(value => {
    const block = props.blocks.get(value.id);
    if (!block || value.boxes.length === 0) return null;
    const bounds = value.boxes.reduce((acc, box) => ({
      x: Math.min(acc.x, box.x), y: Math.min(acc.y, box.y),
      right: Math.max(acc.right, box.x + box.w), bottom: Math.max(acc.bottom, box.y + box.h),
    }), { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity });
    const box = { x: bounds.x, y: bounds.y, w: bounds.right - bounds.x, h: bounds.bottom - bounds.y };
    const lastText = value.items.reduce((last, item, index) => item.kind === 'text' ? index : last, -1);
    // Keep glyphs inside their actual composed backing rectangle. This paints
    // one fill and gives browser contrast/accessibility the same background;
    // titles remain outside body fills. Items arrive in canonical paint order.
    const backedText = new Set<DrawnItem>();
    const backgrounds = new Map<DrawnItem, Array<{ item: Extract<DrawnItem, { kind: 'text' }>; index: number }>>();
    let backing: Extract<DrawnItem, { kind: 'text-background' }> | null = null;
    value.items.forEach((item, index) => {
      if (item.kind === 'text-background') { backing = item; backgrounds.set(item, []); }
      else if (item.kind === 'text' && backing && item.x >= backing.x - 1e-6
        && item.x <= backing.x + backing.w + 1e-6 && item.y - item.size >= backing.y - 1e-6
        && item.y <= backing.y + backing.h + 1e-6) {
        backgrounds.get(backing)?.push({ item, index }); backedText.add(item);
      }
    });
    return (
      // The selectable region contains images, text and tables, so it cannot be a native button.
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
      <div key={value.id} role="button" tabIndex={0} data-preview-block={value.id} data-unresolved={block.kind === 'topic' && !props.topics.has(block.guid) ? '' : undefined} title={'title' in block ? block.title : undefined}
        aria-label={block.kind === 'spacer' ? props.labels('document.addBlock.spacer') : block.kind === 'image' && !block.caption ? props.labels('document.addBlock.image') : undefined}
        className={`cursor-pointer rounded ring-offset-1 hover:ring-1 hover:ring-sky-300 ${props.selectedBlockId === value.id ? 'ring-1 ring-sky-500' : ''}`}
        style={position(box, { x: 0, y: 0, w: 0, h: 0 }, props.scale)}
        onClick={() => props.onSelectBlock(value.id)} onKeyDown={event => {
          if (event.currentTarget === event.target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); props.onSelectBlock(value.id); }
        }}>
        <div data-block-text={block.kind === 'text' ? '' : undefined} data-block-table={block.kind === 'table' ? '' : undefined}
          data-block-ids-report={block.kind === 'ids-report' ? '' : undefined}
          data-ids-report-variant={block.kind === 'ids-report' ? block.variant : undefined} data-block-manual-report={block.kind === 'manual-report' ? '' : undefined}
          style={{ width: '100%', height: '100%', ...(block.kind === 'text' ? { color: block.textColor, whiteSpace: 'pre-wrap',
            fontFamily: DOCUMENT_FONT_FAMILIES[block.font ?? 'helvetica'], fontSize: (block.fontSize ?? TEXT_STYLES[block.style].size) * props.scale * blockScale(block), lineHeight: TEXT_STYLES[block.style].lineHeight } : {}) }}>
          {value.items.map((item, index) => backedText.has(item) ? null : <Item key={index} item={item} block={block} origin={box} props={props}
            lineBreak={index < lastText}>{backgrounds.get(item)?.map(child => <Item key={child.index}
              item={child.item} block={block} origin={itemBox(item, props.measure)} props={props}
              lineBreak={child.index < lastText} />)}</Item>)}
          {block.kind === 'text' && !block.text.trim() && <span className="text-neutral-500">{props.labels('document.preview.textEmpty')}</span>}
          {block.kind === 'spacer' && <span data-block-spacer style={{ display: 'block', height: box.h * props.scale }} />}
        </div>
      </div>
    );
  });
}
