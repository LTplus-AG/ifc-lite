/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Player mode (#5167 Phase 4.1): a form generated from the graph's
 * declared `inputs`, a Run button that runs the SAME graph through the
 * SAME `useFlowRunner` the canvas uses, and the declared `outputs` shown
 * back with `FlowValuePreview` — how a non-author uses a graph as a tool
 * without touching the canvas (Dynamo Player parity).
 *
 * Last-used values persist per graph id (`player-values.ts`, the same
 * localStorage-with-a-safety-net shape `persistence.ts` uses elsewhere in
 * this panel) and are restored the next time this graph opens in Player.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { downloadBlob } from '@/lib/export/download';
import { FlowAutomationEditor } from './FlowAutomationEditor';
import { Play } from 'lucide-react';
import type { FlowDocument, NodeRegistry, RunResult } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslatableMessage } from '@/i18n/types';
import { useBim } from '@/sdk/BimProvider';
import { selectedFiles } from '@/lib/flow/file-values';
import { initialPlayerValues, playerFields, validatePlayerValues } from '@/lib/flow/player-fields';
import { loadPlayerValues, savePlayerValues } from '@/lib/flow/player-values';
import { FlowPlayerField } from './FlowPlayerField';
import { FlowValuePreview } from './FlowValuePreview';
import { useFlowRunner } from './useFlowRunner';

const button = 'rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50';

export interface FlowPlayerProps {
  readonly doc: FlowDocument;
  readonly registry: NodeRegistry<unknown>;
  readonly lastRun: RunResult | null;
  readonly lastError: string | null;
  readonly onDocChange?: (doc: FlowDocument) => void;
}

export function FlowPlayer({ doc, registry, lastRun, lastError, onDocChange }: FlowPlayerProps) {
  const { t } = useTranslation();
  const bim = useBim();
  const { run, canRun, cancel } = useFlowRunner();
  const running = useViewerStore((s) => s.flowRunning);
  const progress = useViewerStore((s) => s.flowProgress);
  const warnings = useViewerStore((s) => s.flowRunWarnings);
  const artifacts = useViewerStore((s) => s.flowArtifacts);
  const [storageError, setStorageError] = useState<string | null>(null);
  const fields = useMemo(() => playerFields(doc, registry), [doc, registry]);
  const storeys = useMemo(() => {
    try {
      return bim.storeys();
    } catch (error) {
      console.warn('[flow] storeys are unavailable for Player', error);
      return [];
    }
  }, [bim]);

  const [values, setValues] = useState<Record<string, unknown>>(() => initialPlayerValues(fields, loadPlayerValues(doc.id)));
  // Restore per-graph values when the open graph changes; a different
  // graph id must never inherit another graph's last-used values. Fields
  // with nothing stored pre-fill from their declared defaults.
  const previousGraph = useRef(doc.id);
  useEffect(() => {
    if (previousGraph.current !== doc.id) {
      previousGraph.current = doc.id;
      setValues(initialPlayerValues(fields, loadPlayerValues(doc.id)));
    } else {
      setValues((previous) => {
        const next = initialPlayerValues(fields, previous);
        for (const field of fields) if (field.input.kind === 'files') next[field.key] = previous[field.key];
        return next;
      });
    }
  }, [doc.id, fields]);

  const selectedFilenames = fields.flatMap((field) => {
    if (field.input.kind !== 'files' || doc.nodes.find((node) => node.id === field.input.nodeId)?.type !== 'session.loadModels') return [];
    try { return Object.values(selectedFiles(values[field.key] ?? {})).flat().map((file) => file.name); }
    catch (error) { console.warn('[flow] filename preview unavailable', error); return []; }
  });
  const validated = useMemo(() => validatePlayerValues(fields, values), [fields, values]);
  const errors: Record<string, TranslatableMessage> = validated.ok ? {} : validated.errors;

  const onRun = () => {
    if (!validated.ok) return;
    // A file's text cannot be shown again by the file widget, so restoring it
    // would silently re-send the old contents — and a large one would push the
    // whole save past its size cap, losing every other field's value.
    const persistable = Object.fromEntries(
      fields.filter((field) => field.input.kind !== 'file' && field.input.kind !== 'files').map((field) => [field.key, values[field.key]]),
    );
    setStorageError(savePlayerValues(doc.id, persistable));
    void run(validated.inputs);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs" data-flow-player>
      {onDocChange && <fieldset disabled={running}><FlowAutomationEditor doc={doc} onChange={onDocChange} selectedFilenames={selectedFilenames} /></fieldset>}
      <fieldset disabled={running}>
      {fields.length === 0 ? (
        <p className="text-muted-foreground">{t('flowPanel.player.empty')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {fields.map((field) => (
            <FlowPlayerField
              key={field.key}
              field={field}
              value={values[field.key]}
              error={errors[field.key]}
              storeys={storeys}
              onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
            />
          ))}
        </div>
      )}

      </fieldset>
      <button
        type="button"
        className={`${button} inline-flex w-fit items-center gap-1 border-[#7aa2f7] text-[#7aa2f7]`}
        disabled={!canRun || !validated.ok}
        onClick={onRun}
      >
        <Play className="h-3 w-3" aria-hidden="true" />{t('flowPanel.run')}
      </button>

      {running && <button type="button" className={button} onClick={cancel}>{t('automationEditor.cancel')}</button>}
      {progress && <output aria-live="polite">{progress}</output>}
      {storageError && <output className="text-amber-500">{t('automationEditor.storageError', { reason: storageError })}</output>}
      {warnings.length > 0 && <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {artifacts.map((artifact) => <button key={artifact.id} type="button" className={button}
        onClick={() => downloadBlob(artifact.blob, artifact.name)}>{t('automationEditor.download', { name: artifact.name })}</button>)}
      {lastError && <div className="text-red-400">{t('flowPanel.run.failed')}: {lastError}</div>}

      {doc.outputs.length > 0 && (
        <div>
          <div className="mb-1 font-medium text-muted-foreground">{t('flowPanel.player.outputs')}</div>
          <div className="flex flex-col gap-2">
            {doc.outputs.map((o) => {
              const data = lastRun?.outputs.get(o.nodeId)?.get(o.port);
              return (
                <div key={`${o.nodeId}.${o.port}`} className="rounded border border-border/60 p-1.5">
                  <div className="mb-1 font-medium">{o.label}</div>
                  {data?.kind === 'item' && typeof data.value === 'string' && data.value.startsWith('flow-resource:')
                    ? <span>{t('automationEditor.preparedResult')}</span> : <FlowValuePreview data={data} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
