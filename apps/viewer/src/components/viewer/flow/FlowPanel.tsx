/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Flow panel (#5167): pick / create / import a graph, edit it on the
 * canvas, run it against the loaded model, read the run back per node.
 * The document on screen is the same `*.flow.json` `ifc-lite flow run`
 * executes — Export writes it unchanged.
 */

import { trackExportCompleted } from '@/lib/analytics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Play } from 'lucide-react';
import { parseFlowDocument, type FlowDocument, type NodeReport } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n/useTranslation';
import { confirmDialog, promptDialog } from '@/components/ui/confirm-dialog';
import { useViewerStore } from '@/store';
import { addNode } from '@/lib/flow/editor-ops';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { flowToJson } from '@/lib/flow/persistence';
import { flowRegistry } from '@/lib/flow/runner';
import { useContributedFlows } from '@/hooks/useContributedFlows';
import { isContributedFlowId } from '@/services/extensions/host-flows.js';
import { FlowCanvas, useCanvasDropPosition } from './FlowCanvas';
import { FlowExampleGallery, FlowExamplePicker } from './FlowExamples';
import { FlowInspector } from './FlowInspector';
import { FlowPalette } from './FlowPalette';
import { FlowPlayer } from './FlowPlayer';
import { FlowPublishButton } from './FlowPublishButton';
import { useFlowRunner } from './useFlowRunner';

type FlowView = 'editor' | 'player';

const select = 'min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5';
const button = 'rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50';

function download(name: string, text: string): void {
  downloadBlob(new Blob([text], { type: 'application/json' }), `${sanitizeFilename(name, { fallback: 'flow' })}.flow.json`);
  trackExportCompleted({ format: 'json', surface: 'flow_panel' });
}

function PaletteWithDrop({ onAdd }: { onAdd: (type: string, pos: [number, number]) => void }) {
  const dropPosition = useCanvasDropPosition();
  return <FlowPalette registry={flowRegistry()} onAdd={(type) => onAdd(type, dropPosition())} />;
}

export function FlowPanel() {
  const { t } = useTranslation();
  const savedFlows = useViewerStore((s) => s.savedFlows);
  const activeFlowId = useViewerStore((s) => s.activeFlowId);
  const flowDoc = useViewerStore((s) => s.flowDoc);
  const flowDirty = useViewerStore((s) => s.flowDirty);
  const selectedNodeId = useViewerStore((s) => s.flowSelectedNodeId);
  const flowRunning = useViewerStore((s) => s.flowRunning);
  const lastRun = useViewerStore((s) => s.flowLastRun);
  const lastError = useViewerStore((s) => s.flowLastError);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const createFlow = useViewerStore((s) => s.createFlow);
  const openFlow = useViewerStore((s) => s.openFlow);
  const saveFlow = useViewerStore((s) => s.saveFlow);
  const deleteFlow = useViewerStore((s) => s.deleteFlow);
  const importFlow = useViewerStore((s) => s.importFlow);
  const setFlowDoc = useViewerStore((s) => s.setFlowDoc);
  const openContributedFlow = useViewerStore((s) => s.openContributedFlow);
  const closeFlow = useViewerStore((s) => s.closeFlow);
  const setSelected = useViewerStore((s) => s.setFlowSelectedNodeId);
  const { run, canRun } = useFlowRunner();
  const fileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<FlowView>('editor');
  const registry = flowRegistry();

  // Extension-contributed graphs (#5167 phase 4.2): read-only until the
  // user duplicates one into their own saved graphs.
  // Whether a contributed graph is open is read off the open document's id,
  // not tracked in a second piece of state: a separate marker could be
  // cleared while `flowDoc` still held the contributed graph, re-enabling
  // the palette, Save and Delete on it (#5431 review).
  const contributed = useContributedFlows();
  // A contributed graph is open with no save target (`openContributedFlow`
  // clears `activeFlowId`); a saved graph always has one, whatever its id.
  const contributedId = flowDoc && activeFlowId === null && isContributedFlowId(flowDoc.id) ? flowDoc.id : null;
  const openedContributed = contributedId === null
    ? null
    : contributed.graphs.find((g) => g.doc.id === contributedId) ?? null;
  const isContributedOpen = contributedId !== null;

  // An extension uninstall closes its graph; an update that changes it
  // reopens the new version. Compared by content: the list is rebuilt on any
  // extension change, and an unrelated one must not reset the last run.
  useEffect(() => {
    if (contributedId === null || !contributed.loaded || !flowDoc) return;
    if (openedContributed === null) closeFlow();
    else if (flowToJson(openedContributed.doc) !== flowToJson(flowDoc)) openContributedFlow(openedContributed.doc);
  }, [contributedId, contributed.loaded, openedContributed, flowDoc, closeFlow, openContributedFlow]);

  useEffect(() => {
    for (const d of contributed.diagnostics) {
      console.warn(`[flow] extension "${d.extensionId}" graph "${d.graphId}": ${d.message}`);
    }
  }, [contributed.diagnostics]);

  const reports = useMemo(() => {
    if (!lastRun) return undefined;
    return new Map<string, NodeReport>(lastRun.reports.map((r) => [r.nodeId, r]));
  }, [lastRun]);

  const onDocChange = useCallback((doc: FlowDocument) => {
    if (isContributedOpen) return; // read-only: edits on a contributed graph are discarded
    setFlowDoc(doc);
  }, [setFlowDoc, isContributedOpen]);

  const onNew = async () => {
    const name = await promptDialog({ description: t('flowPanel.newPrompt'), defaultValue: t('flowPanel.newDefaultName') });
    if (name === null) return;
    if (createFlow(name) === null) setNotice(t('flowPanel.limitReached'));
  };

  const onImportFile = async (file: File) => {
    try {
      const doc = parseFlowDocument(await file.text());
      if (importFlow(doc) === null) setNotice(t('flowPanel.limitReached'));
      else setNotice(null);
    } catch (err) {
      setNotice(t('flowPanel.importFailed', { reason: err instanceof Error ? err.message : String(err) }));
    }
  };

  /**
   * Examples open as a copy under a fresh id: the library entry stays
   * pristine, the same example can be opened twice, and the copy gets its
   * own tracking sidecar rather than inheriting the elements another copy
   * created.
   */
  const onOpenExample = (doc: FlowDocument) => {
    if (importFlow({ ...doc, id: crypto.randomUUID() }) === null) setNotice(t('flowPanel.limitReached'));
    else setNotice(null);
  };

  const onDelete = async () => {
    if (!flowDoc || isContributedOpen) return;
    if (!await confirmDialog({ description: t('flowPanel.deleteConfirm', { name: flowDoc.name }), destructive: true })) return;
    deleteFlow(flowDoc.id);
  };

  const onSelectGraph = (value: string) => {
    if (!value) return;
    if (isContributedFlowId(value)) {
      const entry = contributed.graphs.find((g) => g.doc.id === value);
      if (entry) openContributedFlow(entry.doc);
    } else {
      openFlow(value);
    }
  };

  /** Copy the open contributed graph into the user's own saved graphs, fully editable. */
  const onDuplicateContributed = () => {
    if (!openedContributed) return;
    const copy: FlowDocument = { ...openedContributed.doc, id: crypto.randomUUID() };
    if (importFlow(copy) === null) setNotice(t('flowPanel.limitReached'));
    else setNotice(null);
  };

  const onAddNode = (type: string, pos: [number, number]) => {
    if (!flowDoc) return;
    const { doc, nodeId } = addNode(flowDoc, type, pos);
    setFlowDoc(doc);
    setSelected(nodeId);
  };

  const statusCounts = useMemo(() => {
    const c = { ok: 0, memo: 0, noop: 0, error: 0, skipped: 0 };
    for (const r of lastRun?.reports ?? []) c[r.status] += 1;
    return c;
  }, [lastRun]);

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-flow-panel>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5">
        <span className="font-medium">{t('flowPanel.title')}</span>
        <select className={select} value={contributedId ?? activeFlowId ?? ''} onChange={(e) => onSelectGraph(e.target.value)} aria-label={t('flowPanel.graphAriaLabel')}>
          {savedFlows.length === 0 && contributed.graphs.length === 0 && <option value="">{t('flowPanel.noGraphs')}</option>}
          {savedFlows.map((f) => <option key={f.doc.id} value={f.doc.id}>{f.doc.name}</option>)}
          {contributed.graphs.length > 0 && (
            <optgroup label={t('flowPanel.contributed.optgroup')}>
              {contributed.graphs.map((g) => (
                <option key={g.doc.id} value={g.doc.id}>
                  {t('flowPanel.contributed.optionLabel', { name: g.doc.name, extension: g.extensionName })}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button type="button" className={button} onClick={onNew}>{t('flowPanel.new')}</button>
        <FlowExamplePicker onOpen={onOpenExample} />
        <button type="button" className={button} onClick={() => fileInput.current?.click()}>{t('flowPanel.import')}</button>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" aria-label={t('flowPanel.importAriaLabel')} onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ''; }} />
        {flowDoc && openedContributed && (
          <>
            <span className="text-muted-foreground">{t('flowPanel.contributed.badge', { extension: openedContributed.extensionName })}</span>
            <button type="button" className={button} onClick={onDuplicateContributed} aria-label={t('flowPanel.contributed.duplicateAriaLabel')}>{t('flowPanel.contributed.duplicate')}</button>
          </>
        )}
        {flowDoc && !isContributedOpen && (
          <>
            <button type="button" className={button} onClick={() => download(flowDoc.name, flowToJson(flowDoc))}>{t('flowPanel.export')}</button>
            <button type="button" className={button} disabled={!flowDirty} onClick={saveFlow}>{t('flowPanel.save')}</button>
            <button type="button" className={button} onClick={onDelete}>{t('flowPanel.delete')}</button>
            <span className="text-muted-foreground">{flowDirty ? t('flowPanel.unsaved') : t('flowPanel.saved')}</span>
          </>
        )}
        {/* Player and Publish run the graph and publish that run's writes; neither
            edits nor persists the graph itself, so a read-only contributed graph
            gets them too (#5634). Its publish provenance reads
            `flow:ext:<extension>:<graph>`, naming the extension that shipped it. */}
        {flowDoc && (!isContributedOpen || openedContributed) && (
          <>
            <fieldset className="inline-flex min-w-0 rounded border border-border p-0" aria-label={t('flowPanel.view.ariaLabel')} data-flow-view-toggle>
              <button type="button" className={`px-2 py-0.5 ${view === 'editor' ? 'bg-muted font-medium' : ''}`} aria-pressed={view === 'editor'} onClick={() => setView('editor')}>{t('flowPanel.view.editor')}</button>
              <button type="button" className={`px-2 py-0.5 ${view === 'player' ? 'bg-muted font-medium' : ''}`} aria-pressed={view === 'player'} onClick={() => setView('player')}>{t('flowPanel.view.player')}</button>
            </fieldset>
            {view === 'editor' && (
              <button type="button" className={`${button} inline-flex items-center gap-1 border-[#7aa2f7] text-[#7aa2f7]`} disabled={!canRun} onClick={() => void run()} title={activeModelId ? t('flowPanel.runHint') : t('flowPanel.noModel')}>
                <Play className="h-3 w-3" aria-hidden="true" />{flowRunning ? t('flowPanel.running') : t('flowPanel.run')}
              </button>
            )}
            <FlowPublishButton registry={registry} lastRun={lastRun} lastError={lastError} />
          </>
        )}
        {contributed.diagnostics.length > 0 && (
          <span className="text-amber-300">{t('flowPanel.contributed.diagnostics', { count: contributed.diagnostics.length })}</span>
        )}
        {notice && <span className="text-amber-300">{notice}</span>}
      </div>

      {flowDoc ? (
        view === 'editor' ? (
          <ReactFlowProvider>
            <div className="flex min-h-0 flex-1">
              {!isContributedOpen && <PaletteWithDrop onAdd={onAddNode} />}
              <div className="relative min-w-0 flex-1">
                <FlowCanvas doc={flowDoc} registry={registry} reports={reports} selectedNodeId={selectedNodeId} onDocChange={onDocChange} onSelect={setSelected} onConnectError={setNotice} />
                {flowDoc.nodes.length === 0 && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">{t('flowPanel.emptyCanvas')}</div>}
              </div>
              <FlowInspector doc={flowDoc} registry={registry} nodeId={selectedNodeId} lastRun={lastRun} onDocChange={onDocChange} onSelect={setSelected} />
            </div>
          </ReactFlowProvider>
        ) : (
          <FlowPlayer doc={flowDoc} registry={registry} lastRun={lastRun} lastError={lastError} />
        )
      ) : (
        <FlowExampleGallery onOpen={onOpenExample} />
      )}

      {(lastRun || lastError) && (
        <div className="flex flex-wrap items-center gap-x-3 border-t border-border px-3 py-1 text-2xs" data-flow-run-bar>
          {lastError && <span className="text-red-400">{t('flowPanel.run.failed')}: {lastError}</span>}
          {lastRun && (
            <>
              <span className={lastRun.ok ? 'text-emerald-300' : 'text-red-400'}>{lastRun.ok ? t('flowPanel.run.ok') : t('flowPanel.run.failed')}</span>
              <span className="text-muted-foreground">{t('flowPanel.run.summary', statusCounts)}</span>
              {lastRun.writes > 0 && <span className="text-muted-foreground">{t('flowPanel.run.writes', { count: lastRun.writes })}</span>}
              {lastRun.log.filter((l) => l.level === 'error').slice(0, 3).map((l, i) => <span key={i} className="text-red-400">{l.nodeId}{l.laneKey ? `[${l.laneKey}]` : ''}: {l.message}</span>)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
