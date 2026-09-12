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
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { readImageFile } from '@/lib/document/persistence';
import { FIELD_SUGGESTIONS } from '@/lib/document/presets';
import { elementPropertyPaths, type BindingContext } from '@/lib/document/bindings';
import { expressIdToGlobalId } from '@/hooks/bcfIdLookup';
import type { DocumentBlock, TextBlock } from '@/lib/document/types';

export interface BlockEditorProps {
  block: DocumentBlock;
  index: number;
  count: number;
  bindings: BindingContext;
  topics: Map<string, BCFTopic>;
  /** Every chart of every saved dashboard, to copy into a chart block. */
  charts: Array<{ dashboard: string; chart: ChartSpec }>;
  onChange: (block: DocumentBlock) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

const KIND_LABEL: Record<DocumentBlock['kind'], string> = { text: 'Text', image: 'Image', chart: 'Chart', topic: 'BCF topic' };
const field = 'min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs';

/** The fields offered for insertion: the fixed suggestions, the model's storeys, and the selected element. */
function useFieldOptions(bindings: BindingContext): Array<{ path: string; label: string }> {
  const models = useViewerStore((s) => s.models);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
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
    const guid = first === null ? null : expressIdToGlobalId(first, models, ifcDataStore);
    if (guid) {
      for (const attr of ['Name', 'Type', 'Description', 'ObjectType', 'Tag', 'Storey']) options.push({ path: `Element[${guid}].${attr}`, label: `Selected element · ${attr}` });
      // The selected element's property and quantity sets, so a Pset value is one pick away.
      for (const p of elementPropertyPaths(guid, bindings)) options.push({ path: p.path, label: `Selected element · ${p.label}` });
    }
    return options;
  }, [bindings, models, ifcDataStore, selected]);
}

function TextEditor({ block, bindings, onChange }: { block: TextBlock; bindings: BindingContext; onChange: (b: TextBlock) => void }) {
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
        <label className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">Style
          <select className={field} value={block.style} onChange={(e) => onChange({ ...block, style: e.target.value as TextBlock['style'] })} aria-label="Text style">
            <option value="title">Title</option><option value="heading">Heading</option><option value="body">Body</option>
          </select>
        </label>
        <label className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap text-muted-foreground">Insert field
          <select className={`${field} max-w-[190px]`} value="" onChange={(e) => { if (e.target.value) insert(e.target.value); }} aria-label="Insert field" title="Insert a {path} that reads the model">
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
        aria-label="Block text"
        placeholder="Text; {IfcProject.Name} reads the model"
      />
    </>
  );
}

export function BlockEditor({ block, index, count, bindings, topics, charts, onChange, onMove, onRemove }: BlockEditorProps) {
  const [busy, setBusy] = useState(false);
  const pickImage = async (file: File | undefined): Promise<void> => {
    if (!file || block.kind !== 'image') return;
    setBusy(true);
    try {
      onChange({ ...block, dataUrl: await readImageFile(file) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read the image');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2 text-xs" data-block-editor={block.id} data-block-kind={block.kind}>
      <div className="flex items-center gap-1">
        <span className="font-medium">{KIND_LABEL[block.kind]}</span>
        <span className="text-muted-foreground">#{index + 1}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move block up"><ArrowUp className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move block down"><ArrowDown className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onRemove} aria-label="Remove block"><X className="h-3.5 w-3.5" /></Button>
      </div>

      {block.kind === 'text' && <TextEditor block={block} bindings={bindings} onChange={onChange} />}

      {block.kind === 'image' && (
        <>
          <div className="flex items-center gap-2">
            {block.dataUrl ? <img src={block.dataUrl} alt="" className="h-10 rounded border border-border object-contain" /> : <span className="text-muted-foreground">No image yet</span>}
            <label className="cursor-pointer rounded border border-border px-2 py-0.5 hover:bg-accent">
              {busy ? 'Reading…' : 'Choose PNG / JPEG…'}
              <input type="file" accept="image/png,image/jpeg" className="hidden" data-image-input onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1 text-muted-foreground">Height (pt)
              <input type="number" min={20} max={600} className={`${field} w-16`} value={block.height} onChange={(e) => onChange({ ...block, height: Math.max(20, Number(e.target.value) || 20) })} aria-label="Image height" />
            </label>
            <label className="inline-flex items-center gap-1 text-muted-foreground">Align
              <select className={field} value={block.align} onChange={(e) => onChange({ ...block, align: e.target.value as 'left' | 'center' | 'right' })} aria-label="Image alignment">
                <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
              </select>
            </label>
            <input className={`${field} flex-1`} value={block.caption ?? ''} placeholder="Caption" onChange={(e) => onChange({ ...block, caption: e.target.value || undefined })} aria-label="Image caption" />
          </div>
        </>
      )}

      {block.kind === 'chart' && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">Chart
            <select
              className={`${field} min-w-0 flex-1`}
              value=""
              onChange={(e) => {
                const pick = charts[Number(e.target.value)];
                if (pick) onChange({ ...block, chart: { ...pick.chart, id: block.chart.id } });
              }}
              aria-label="Chart from a dashboard"
              title="Copy a chart from one of the saved dashboards"
            >
              <option value="">{block.chart.title} — replace with…</option>
              {charts.map((c, i) => <option key={`${c.dashboard}:${c.chart.id}`} value={i}>{c.dashboard} › {c.chart.title}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={block.snapshot} onChange={(e) => onChange({ ...block, snapshot: e.target.checked })} className="accent-[#7aa2f7]" /> 3D snapshot
          </label>
        </div>
      )}

      {block.kind === 'topic' && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">Topic
            <select className={`${field} min-w-0 flex-1`} value={block.guid} onChange={(e) => onChange({ ...block, guid: e.target.value })} aria-label="BCF topic">
              {!topics.has(block.guid) && <option value={block.guid}>{block.guid ? `${block.guid} (not loaded)` : 'Pick a topic…'}</option>}
              {[...topics.values()].map((t) => <option key={t.guid} value={t.guid}>{t.title}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={block.snapshot} onChange={(e) => onChange({ ...block, snapshot: e.target.checked })} className="accent-[#7aa2f7]" /> Viewpoint snapshot
          </label>
        </div>
      )}
    </div>
  );
}
