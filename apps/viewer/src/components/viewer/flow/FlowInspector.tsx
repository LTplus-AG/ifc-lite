/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selected node: label, parameters (from the node's `ParamDef`s),
 * lacing, tracking, Player input / graph output markers, and the last
 * run's report and port values.
 */

import { useState } from 'react';
import type { FlowDocument, Lacing, NodeDef, NodeRegistry, ParamDef, RunResult, TrackingMode } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n/useTranslation';
import { removeNode, setLacing, setParam, setTracking, toggleInput, toggleOutput, updateNode } from '@/lib/flow/editor-ops';
import { KIND_COLOR, describeData } from '@/lib/flow/view-model';
import { FlowCodeParam } from './FlowCodeParam';
import { FlowValuePreview } from './FlowValuePreview';

const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs';
const LACINGS: readonly Lacing[] = ['shortest', 'longest', 'cross'];
const TRACKINGS: readonly TrackingMode[] = ['update', 'replace', 'disabled'];

function ParamField({ def, value, onChange, invalidLabel, node }: { def: ParamDef; value: unknown; onChange: (v: unknown) => void; invalidLabel: string; node: NodeDef<unknown> }) {
  const [jsonText, setJsonText] = useState<string | null>(null);
  const current = value ?? def.default;
  switch (def.kind) {
    case 'code':
      return (
        <FlowCodeParam
          def={def}
          value={value}
          nodeTitle={node.title}
          inputNames={node.inputs.map((p) => p.name)}
          outputName={node.outputs[0]?.name ?? 'result'}
          onChange={onChange}
        />
      );
    case 'boolean':
      return <input type="checkbox" checked={current === true} onChange={(e) => onChange(e.target.checked)} className="accent-[#7aa2f7]" />;
    case 'number':
      return <input type="number" className={input} value={typeof current === 'number' ? current : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
    case 'enum':
      return (
        <select className={input} value={String(current ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'json': {
      const text = jsonText ?? JSON.stringify(current ?? null);
      let invalid = false;
      try { JSON.parse(text); } catch { invalid = true; }
      return (
        <div>
          <textarea
            className={`${input} font-mono ${invalid ? 'border-red-400' : ''}`}
            rows={2}
            value={text}
            onChange={(e) => {
              setJsonText(e.target.value);
              try { onChange(JSON.parse(e.target.value)); } catch { /* keep typing; the border says it is not JSON yet */ }
            }}
            onBlur={() => setJsonText(null)}
          />
          {invalid && <div className="text-2xs text-red-400">{invalidLabel}</div>}
        </div>
      );
    }
    default:
      return <input className={input} value={typeof current === 'string' ? current : ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

export interface FlowInspectorProps {
  readonly doc: FlowDocument;
  readonly registry: NodeRegistry<unknown>;
  readonly nodeId: string | null;
  readonly lastRun: RunResult | null;
  readonly onDocChange: (doc: FlowDocument) => void;
  readonly onSelect: (nodeId: string | null) => void;
}

export function FlowInspector({ doc, registry, nodeId, lastRun, onDocChange, onSelect }: FlowInspectorProps) {
  const { t } = useTranslation();
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) return <div className="w-64 shrink-0 border-l border-border p-2 text-xs text-muted-foreground">{t('flowPanel.inspector.empty')}</div>;
  const def = registry.get(node.type);
  const report = lastRun?.reports.find((r) => r.nodeId === node.id);
  const outputs = lastRun?.outputs.get(node.id);
  const hasItemPort = def?.inputs.some((p) => p.type.access === 'item') ?? false;

  return (
    <div className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border p-2 text-xs" data-flow-inspector>
      <div>
        <div className="font-medium">{def?.title ?? node.type}</div>
        <div className="font-mono text-2xs text-muted-foreground">{node.id} · {node.type}</div>
        {!def && <div className="text-red-400">{t('flowPanel.inspector.unknownType', { type: node.type })}</div>}
        {/* The palette only shows the doc as a tooltip, which is unreachable once the node is on the canvas. */}
        {def?.doc && <div className="mt-1 text-2xs leading-snug text-muted-foreground">{def.doc}</div>}
        {def && def.capabilities.length > 0 && <div className="text-2xs text-muted-foreground">{t('flowPanel.inspector.capabilities')}: {def.capabilities.join(', ')}</div>}
      </div>

      <label className="block">
        <span className="text-muted-foreground">{t('flowPanel.inspector.label')}</span>
        <input className={input} value={node.label ?? ''} onChange={(e) => onDocChange(updateNode(doc, node.id, { label: e.target.value || undefined }))} />
      </label>

      {def && def.params.length > 0 && (
        <div>
          <div className="text-muted-foreground">{t('flowPanel.inspector.params')}</div>
          {def.params.map((p) => {
            const isInput = doc.inputs.some((i) => i.nodeId === node.id && i.param === p.name);
            return (
              <div key={p.name} className="mt-1">
                <div className="flex items-center justify-between">
                  <span title={p.doc}>{p.name}</span>
                  <label className="inline-flex items-center gap-1 text-2xs text-muted-foreground" title={t('flowPanel.inspector.isInput')}>
                    <input type="checkbox" checked={isInput} onChange={() => onDocChange(toggleInput(doc, node.id, p.name, `${node.label ?? def.title}: ${p.name}`))} className="accent-[#e0af68]" />▸
                  </label>
                </div>
                <ParamField def={p} value={node.params?.[p.name]} onChange={(v) => onDocChange(setParam(doc, node.id, p.name, v))} invalidLabel={t('flowPanel.inspector.jsonInvalid')} node={def} />
              </div>
            );
          })}
        </div>
      )}

      {hasItemPort && (
        <label className="block">
          <span className="text-muted-foreground">{t('flowPanel.inspector.lacing')}</span>
          <select className={input} value={node.lacing ?? 'shortest'} onChange={(e) => onDocChange(setLacing(doc, node.id, e.target.value as Lacing))}>
            {LACINGS.map((l) => <option key={l} value={l}>{t(`flowPanel.inspector.lacing.${l}` as const)}</option>)}
          </select>
        </label>
      )}

      {def?.tracked && (
        <div>
          <label className="block">
            <span className="text-muted-foreground">{t('flowPanel.inspector.tracking')}</span>
            <select className={input} value={node.tracking ?? 'update'} onChange={(e) => onDocChange(setTracking(doc, node.id, e.target.value as TrackingMode, node.trackingKey))}>
              {TRACKINGS.map((m) => <option key={m} value={m}>{t(`flowPanel.inspector.tracking.${m}` as const)}</option>)}
            </select>
          </label>
          <label className="mt-1 block" title={t('flowPanel.inspector.trackingKeyHint')}>
            <span className="text-muted-foreground">{t('flowPanel.inspector.trackingKey')}</span>
            <input className={`${input} font-mono`} placeholder={`${doc.name}/${node.label ?? node.id}`} value={node.trackingKey ?? ''} onChange={(e) => onDocChange(setTracking(doc, node.id, node.tracking ?? 'update', e.target.value))} />
          </label>
        </div>
      )}

      {def && def.outputs.length > 0 && (
        <div>
          <div className="text-muted-foreground">{t('flowPanel.inspector.outputs')}</div>
          {def.outputs.map((p) => {
            const isOutput = doc.outputs.some((o) => o.nodeId === node.id && o.port === p.name);
            const data = outputs?.get(p.name);
            return (
              <div key={p.name} className="mt-1 rounded border border-border/60 p-1">
                <div className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[p.type.kind] }} />
                  <span>{p.name}</span>
                  <span className="text-2xs text-muted-foreground">{p.type.kind}/{p.type.access}</span>
                  <span className="ml-auto text-2xs text-muted-foreground">{describeData(data)}</span>
                  <label className="inline-flex items-center gap-1 text-2xs text-muted-foreground" title={t('flowPanel.inspector.isOutput')}>
                    <input type="checkbox" checked={isOutput} onChange={() => onDocChange(toggleOutput(doc, node.id, p.name, `${node.label ?? def.title}: ${p.name}`))} className="accent-[#9ece6a]" />▪
                  </label>
                </div>
                {data && <div className="mt-1 max-h-40 overflow-auto"><FlowValuePreview data={data} /></div>}
              </div>
            );
          })}
        </div>
      )}

      {report && (
        <div className="text-2xs text-muted-foreground">
          <div>{t('flowPanel.inspector.lastRun')}: {t(`flowPanel.status.${report.status}` as const)} · {t('flowPanel.inspector.lanes', { count: report.lanes })}{report.laneErrors > 0 ? ` · ${t('flowPanel.inspector.laneErrors', { count: report.laneErrors })}` : ''}</div>
          {report.tracking && <div>{t('flowPanel.inspector.tracked', report.tracking)}</div>}
          {report.error && <div className="text-red-400">{report.error}</div>}
        </div>
      )}

      <button type="button" className="mt-auto rounded border border-border px-2 py-0.5 text-left hover:bg-muted" onClick={() => { onDocChange(removeNode(doc, node.id)); onSelect(null); }}>
        {t('flowPanel.inspector.remove')}
      </button>
    </div>
  );
}
