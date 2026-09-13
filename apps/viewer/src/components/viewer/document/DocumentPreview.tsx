/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The document as a page (#4594): every block resolved against the loaded
 * model, on a white sheet in the page's proportions. Charts are the same
 * SSR SVG the PDF gets; an unresolved binding is marked in place, never
 * printed as an empty string.
 */
import { useMemo } from 'react';
import { renderChartSvg, type Aggregation } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import { renderTemplate, type BindingContext } from '@/lib/document/bindings';
import { REPORT_THEME } from '@/lib/export/report/generate-report-pdf';
import { topicLines, topicSnapshotDataUrl } from '@/lib/document/generate-document-pdf';
import { pageBox } from '@/lib/export/report/compose';
import type { DocumentBlock, DocumentSpec, TextBlock } from '@/lib/document/types';

export interface DocumentPreviewProps {
  document: DocumentSpec;
  bindings: BindingContext;
  aggregations: Map<string, Aggregation | null>;
  topics: Map<string, BCFTopic>;
  selectedBlockId: string | null;
  onSelectBlock: (id: string) => void;
}

const TEXT_CLASS: Record<TextBlock['style'], string> = {
  title: 'text-2xl font-semibold leading-tight',
  heading: 'text-base font-semibold mt-2',
  body: 'text-sm leading-relaxed whitespace-pre-wrap',
};

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

function ChartSvg({ aggregation, width }: { aggregation: Aggregation | null; width: number }) {
  const svg = useMemo(() => (aggregation && aggregation.categories.length > 0
    ? renderChartSvg({ aggregation, width, height: 220, theme: REPORT_THEME, showTitle: false })
    : null), [aggregation, width]);
  if (!svg) return <div className="flex h-24 items-center justify-center rounded border border-dashed border-neutral-300 text-xs text-neutral-500">No data for this chart.</div>;
  // The SVG string is ECharts' own output over data we aggregated; nothing user-authored is in it.
  return <div className="w-full overflow-hidden" dangerouslySetInnerHTML={{ __html: svg }} data-chart-svg />;
}

function Block({ block, bindings, aggregation, topic, contentWidth }: { block: DocumentBlock; bindings: BindingContext; aggregation: Aggregation | null; topic: BCFTopic | undefined; contentWidth: number }) {
  switch (block.kind) {
    case 'text':
      return <div className={TEXT_CLASS[block.style]} data-block-text>{block.text.trim() ? <ResolvedText text={block.text} bindings={bindings} /> : <span className="text-neutral-400">(empty)</span>}</div>;
    case 'image': {
      const justify = block.align === 'left' ? 'justify-start' : block.align === 'right' ? 'justify-end' : 'justify-center';
      return (
        <figure className={`flex flex-col ${block.align === 'center' ? 'items-center' : block.align === 'right' ? 'items-end' : 'items-start'}`}>
          <div className={`flex w-full ${justify}`}>
            {block.dataUrl
              ? <img src={block.dataUrl} alt={block.caption ?? ''} style={{ height: block.height * (contentWidth / 515) }} className="max-w-full object-contain" />
              : <div className="flex items-center justify-center rounded border border-dashed border-neutral-300 px-3 text-xs text-neutral-500" style={{ height: block.height * (contentWidth / 515), minWidth: 80 }}>No image yet</div>}
          </div>
          {block.caption && <figcaption className="text-[10px] text-neutral-500">{block.caption}</figcaption>}
        </figure>
      );
    }
    case 'chart':
      return (
        <div>
          <div className="text-sm font-semibold">{block.chart.title} <span className="text-[10px] font-normal text-neutral-500">{aggregation ? `${aggregation.categories.length} bucket${aggregation.categories.length === 1 ? '' : 's'} · ${aggregation.total.toLocaleString()}` : 'No data'}{block.snapshot ? ' · 3D snapshot in the PDF' : ''}</span></div>
          <ChartSvg aggregation={aggregation} width={contentWidth} />
        </div>
      );
    case 'topic': {
      if (!topic) return <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900" data-unresolved>BCF topic {block.guid} is not among the loaded topics.</div>;
      const snapshot = block.snapshot ? topicSnapshotDataUrl(topic) : null;
      return (
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{topic.title}</div>
            {topicLines(topic).map((line, i) => <div key={i} className="text-xs text-neutral-700">{line}</div>)}
          </div>
          {snapshot && <img src={snapshot} alt="" className="h-28 rounded border border-neutral-200 object-cover" />}
        </div>
      );
    }
  }
}

export function DocumentPreview({ document, bindings, aggregations, topics, selectedBlockId, onSelectBlock }: DocumentPreviewProps) {
  const size = pageBox(document.page);
  // The sheet scales to the panel; block content is laid out at this width.
  const width = 560;
  const contentWidth = width * (1 - 80 / size.w);
  return (
    <div className="flex justify-center p-3" data-document-preview>
      <div
        className="bg-white text-neutral-900 shadow-md"
        style={{ width, minHeight: width * (size.h / size.w), padding: `${(40 / size.w) * width}px`, fontFamily: 'Helvetica, Arial, sans-serif' }}
      >
        <div className="mb-3 text-[9px] text-neutral-400">{document.name}</div>
        <div className="flex flex-col gap-2.5">
          {document.blocks.map((block) => (
            <div
              key={block.id}
              className={`-mx-1 cursor-pointer rounded px-1 ring-offset-1 hover:ring-1 hover:ring-sky-300 ${selectedBlockId === block.id ? 'ring-1 ring-sky-500' : ''}`}
              onClick={() => onSelectBlock(block.id)}
              data-preview-block={block.id}
            >
              <Block block={block} bindings={bindings} aggregation={aggregations.get(block.id) ?? null} topic={block.kind === 'topic' ? topics.get(block.guid) : undefined} contentWidth={contentWidth} />
            </div>
          ))}
          {document.blocks.length === 0 && <div className="text-xs text-neutral-400">An empty page — add a block on the left.</div>}
        </div>
      </div>
    </div>
  );
}
