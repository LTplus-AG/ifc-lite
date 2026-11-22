/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_MAPPING, generateArtifacts, asJsonLd,
  type SparqlResults } from '@ifc-lite/semantic';
import { useViewerStore } from '@/store';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { useIfcLoader } from '@/hooks/useIfcLoader';
import { downloadFile } from '@/lib/export/download';
import { DEMO_REVISIONS, PILOT_QUERY, pilotDocument, pilotModel } from './demo';
import { useSemanticSession, savedSemanticWorkspace } from './session';
import { liveEntities } from './viewer';
import { queryForSelection } from './related-query';
import { validateInWorker } from './validation-worker';
import { validateCurrentSemantic } from './validate-current';
import type { ValidationJob } from './validation-job';

import { loadSemanticSource, type SourceInput, type ValidationExecutor } from './load-source';
export type { SourceInput, ValidationExecutor } from './load-source';
export function useSemanticPilot(execute: ValidationExecutor = validateInWorker) {
  const session = useSemanticSession();
  const { document, results, graph, revisions, profile, setDocument, setGraph, setResults, setFindings, setRevisions } = session;
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [diagnostic, setDiagnostic] = useState('');
  const current = useRef<AbortController | null>(null); const { loadFile } = useIfcLoader();
  useEffect(() => () => current.current?.abort(), []);
  useEffect(() => { current.current?.abort(); }, [profile]);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    current.current?.abort(); const controller = new AbortController(); current.current = controller;
    setBusy(true); setError(''); setDiagnostic('');
    try { await action(controller.signal); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (current.current === controller) { setBusy(false); current.current = null; } }
  }
  async function accept(job: ValidationJob, signal: AbortSignal, bindings?: SparqlResults, guard?: () => boolean) {
    const inputVersion = useSemanticSession.getState().dataVersion;
    const validated = await execute({ ...job, profile }, signal);
    if (signal.aborted || useSemanticSession.getState().profile !== profile || useSemanticSession.getState().dataVersion !== inputVersion) return false;
    if (guard && !guard()) throw new Error('Loaded models changed during retrieval; load the records again');
    setDocument(validated.document); setGraph(validated.graph); session.setGraphFormat('application/n-quads'); setResults(bindings); setFindings(validated.findings); setDiagnostic(validated.diagnostic ?? ""); session.setReport(validated.diagnostic ? undefined : validated.report);
    return true;
  }
  function load(input: SourceInput, onRetrieved?: () => void) {
    return run(async signal => { const outcome = await loadSemanticSource(input, signal, execute, onRetrieved); if (!signal.aborted) setDiagnostic(outcome.diagnostic); });
  }
  function related(input: SourceInput, onRetrieved?: () => void) {
    try {
      const query = queryForSelection({ selection: createSelectionAdapter(useViewerStore).get(), entities: liveEntities(),
        revisions, profile, mapping: session.resultMapping ?? input.mapping, document, results, settings: session });
      return load({ ...input, mode: 'sparql', query, mapping: { ...DEFAULT_MAPPING, id: 'subject' } }, onRetrieved);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return Promise.resolve(); }
  }
  function demo(withModels: boolean) {
    return run(async signal => {
      if (withModels) {
        const associations = new Map<string, string>();
        for (let index = 0; index < 2; index++) {
          if (signal.aborted) return;
          const modelId = crypto.randomUUID();
          await loadFile(new File([pilotModel(index).content], `semantic-pilot-${index + 1}.ifc`), { kind: 'federated', modelId, name: `Linked records pilot ${index + 1}` });
          const loaded = useViewerStore.getState().models.get(modelId);
          if (!loaded?.ifcDataStore || loaded.loadState === 'error') throw new Error('Pilot model failed to load');
          associations.set(DEMO_REVISIONS[index], modelId);
        }
        if (signal.aborted) return; setRevisions(associations);
      }
      if (await accept({ document: pilotDocument() }, signal)) session.setRetrievedAt(undefined);
    });
  }
  function validate(suppliedGraph = false) {
    return run(async signal => {
      const value = await validateCurrentSemantic(suppliedGraph, signal, execute);
      setDiagnostic(value.diagnostic ?? '');
    });
  }
  function editGraph(value: string) {
    current.current?.abort(); setDiagnostic(''); session.setGraph(value);
  }
  function exportBundle() {
    return run(async signal => {
      const assets = await generateArtifacts(profile);
      const bundle = { document, ...assets, jsonLd: document ? asJsonLd(document, profile) : undefined, graph, graphFormat: session.graphFormat,
        nquads: session.graphFormat === 'application/n-quads' ? graph : undefined,
        selectQuery: PILOT_QUERY, sparqlResults: results, note: 'Original reference profile; no standards conformity claim.' };
      if (!signal.aborted) downloadFile(JSON.stringify(bundle, null, 2), 'semantic-records.json', 'application/json');
    });
  }
  function saveWorkspace() { try { downloadFile(session.save(), 'semantic-workspace.json', 'application/json'); } catch (failure) { setError(String(failure)); } }
  function restoreWorkspace(serialized?: string) {
    try { const value = serialized ?? savedSemanticWorkspace(); if (!value) throw new Error('No saved workspace'); current.current?.abort(); session.restore(value); setDiagnostic(''); }
    catch (failure) { setError(String(failure)); }
  }
  return { ...session, setGraph: editGraph, busy, error, diagnostic, setError, load, related, demo, validate, exportBundle, saveWorkspace, restoreWorkspace,
    cancel: () => current.current?.abort() };
}
