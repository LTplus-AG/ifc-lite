/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Paper preview uses the existing resolved-block/PDF composer (#6610).
 * Text, tables and reports overflow onto actual pages; explicit sections do
 * not stand in for page numbers. Selection still targets the authored block. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Aggregation } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import { useTranslation } from '@/i18n';
import { captureTranslation } from '@/i18n/registry';
import type { BindingContext } from '@/lib/document/bindings';
import type { DocumentSpec } from '@/lib/document/types';
import type { DocumentLabelFormatter } from '@/lib/document/document-labels';
import type { DocumentPdfInput } from '@/lib/document/generate-document-pdf';
import { topicSnapshotDataUrl } from '@/lib/document/generate-document-pdf';
import { pageBox, REPORT_MARGIN } from '@/lib/export/report/compose';
import { DOCUMENT_FONT_FAMILIES } from '@/lib/document/text-typography';
import type { TableState } from '@/lib/document/resolve-table';
import { DOCUMENT_PREVIEW_MUTED_TEXT_CLASS, DOCUMENT_PREVIEW_PAPER_CLASS, previewTextPaint } from './preview-theme';
import { ComposedPageItems } from './ComposedPageItems';
import { useDocumentLayout, type PreviewImageSize } from './useDocumentLayout';

export interface DocumentPreviewProps {
  document: DocumentSpec;
  bindings: BindingContext;
  aggregations: Map<string, Aggregation | null>;
  chartMessages: Map<string, string>;
  topics: Map<string, BCFTopic>;
  tables?: ReadonlyMap<string, TableState>;
  labels?: DocumentLabelFormatter;
  selectedBlockId: string | null;
  onSelectBlock: (id: string) => void;
}

const EMPTY_TABLES = new Map<string, TableState>();
const EMPTY_IDS = (): readonly number[] => [];

export function DocumentPreview(props: DocumentPreviewProps) {
  const { revision } = useTranslation();
  const capturedLabels = useMemo(() => captureTranslation(), [revision]);
  const labels = props.labels ?? capturedLabels;
  const [imageFailures, setImageFailures] = useState<ReadonlySet<string>>(new Set());
  const [imageSizes, setImageSizes] = useState<ReadonlyMap<string, PreviewImageSize>>(new Map());
  const imageUrls = useMemo(() => new Set(props.document.blocks.flatMap(block => {
    if (block.kind === 'image') return block.dataUrl ? [block.dataUrl] : [];
    const topic = block.kind === 'topic' && block.snapshot ? props.topics.get(block.guid) : undefined;
    const url = topic ? topicSnapshotDataUrl(topic) : null;
    return url ? [url] : [];
  })), [props.document, props.topics]);
  const activeImageUrls = useRef(imageUrls);
  activeImageUrls.current = imageUrls;
  useEffect(() => {
    setImageFailures(prior => [...prior].every(url => imageUrls.has(url))
      ? prior : new Set([...prior].filter(url => imageUrls.has(url))));
    setImageSizes(prior => [...prior.keys()].every(url => imageUrls.has(url))
      ? prior : new Map([...prior].filter(([url]) => imageUrls.has(url))));
  }, [imageUrls]);
  const recordImageSize = useCallback((url: string, size: PreviewImageSize) => {
    if (!activeImageUrls.current.has(url)) return;
    setImageSizes(prior => {
      const stored = prior.get(url);
      if (stored?.w === size.w && stored.h === size.h) return prior;
      return new Map(prior).set(url, size);
    });
  }, []);
  const recordImageError = useCallback((url: string) => {
    if (!activeImageUrls.current.has(url)) return;
    console.warn('[Documents] preview image could not be decoded');
    setImageFailures(prior => new Set(prior).add(url));
    // Let the shared resolver choose its existing failed-measurement fallback:
    // square for ordinary images and 4:3 for BCF snapshots.
    recordImageSize(url, { w: 0, h: 0 });
  }, [recordImageSize]);
  const input = useMemo<DocumentPdfInput>(() => ({ document: props.document, bindings: props.bindings,
    aggregations: props.aggregations, chartMessages: props.chartMessages, topics: props.topics,
    tables: props.tables ?? EMPTY_TABLES, snapshotIds: EMPTY_IDS, labels }),
  [props.document, props.bindings, props.aggregations, props.chartMessages, props.topics, props.tables, labels]);
  const { value, error } = useDocumentLayout(input, imageSizes);
  const blocks = useMemo(() => new Map(props.document.blocks.map(block => [block.id, block])), [props.document]);
  if (error) return <div role="alert" className="p-3 text-xs text-destructive">{labels('document.print.layoutError', { message: error })}</div>;
  const width = 560;
  if (!value) {
    // Keep the fixed print surface while the shared font metrics load, also
    // during server rendering. No provisional body pagination is invented.
    const size = pageBox(props.document.page);
    return <div data-document-preview aria-busy="true" className="flex flex-col items-center gap-4 p-3">
      <section data-document-preview-paper className={`${DOCUMENT_PREVIEW_PAPER_CLASS} relative shadow-md`}
        style={{ width, height: size.h * width / size.w }}>
        <span className={`${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS} block p-3 text-xs`}>{labels('document.print.preparing')}</span>
      </section>
    </div>;
  }
  const { layout, measure } = value;
  const scale = width / layout.size.w;
  const pendingImages = [...imageUrls].some(url => !imageSizes.has(url));
  const heading = layout.pageHeading;
  // The resolved heading contains a default PDF color even when the author
  // supplied only text/font. Only an actual authored color overrides UI ink.
  const headingPaint = previewTextPaint(150, props.document.pageHeading?.textColor);
  const footerPaint = previewTextPaint(150);
  return <div className="flex flex-col items-center gap-4 p-3" data-document-preview aria-busy={pendingImages}>
    {layout.pages.map(page => <section key={page.index} data-document-preview-paper data-preview-section={page.index + 1}
      aria-label={labels('document.preview.sectionLabel', { section: String(page.index + 1) })}
      className={`${DOCUMENT_PREVIEW_PAPER_CLASS} relative shadow-md`}
      style={{ width, height: layout.size.h * scale, fontFamily: DOCUMENT_FONT_FAMILIES.helvetica, overflow: 'hidden' }}>
      <div data-page-heading className={headingPaint.className} title={heading?.text ?? layout.header} style={{ position: 'absolute', left: REPORT_MARGIN * scale,
        top: ((heading?.y ?? REPORT_MARGIN - 8) - (heading?.fontSize ?? 8)) * scale,
        color: headingPaint.color, fontFamily: DOCUMENT_FONT_FAMILIES[heading?.font ?? 'helvetica'],
        fontSize: (heading?.fontSize ?? 8) * scale, lineHeight: 1.25, whiteSpace: 'pre' }}>{heading?.text ?? layout.header}</div>
      <ComposedPageItems page={page} blocks={blocks} aggregations={props.aggregations} chartMessages={props.chartMessages}
        topics={props.topics} scale={scale} measure={measure} labels={labels} selectedBlockId={props.selectedBlockId}
        onSelectBlock={props.onSelectBlock} onImageSize={recordImageSize} imageFailures={imageFailures} onImageError={recordImageError} />
      <div data-page-footer className={footerPaint.className} style={{ position: 'absolute', left: REPORT_MARGIN * scale,
        top: (layout.size.h - REPORT_MARGIN + 12 - 8) * scale, fontSize: 8 * scale, color: footerPaint.color, lineHeight: 1.25 }}>
        {layout.footer}
      </div>
      <div data-page-counter className={footerPaint.className} style={{ position: 'absolute', left: (layout.size.w - REPORT_MARGIN - 60) * scale,
        top: (layout.size.h - REPORT_MARGIN + 12 - 8) * scale, fontSize: 8 * scale, color: footerPaint.color, lineHeight: 1.25, whiteSpace: 'pre' }}>
        {pendingImages ? labels('document.print.preparing') : layout.pageCounters?.[page.index]}
      </div>
    </section>)}
  </div>;
}
