/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_MAPPING, createSemanticProvider, generateArtifacts, asJsonLd,
  type BindingMapping, type SparqlResults } from '@ifc-lite/semantic';
import { useViewerStore } from '@/store';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { useIfcLoader } from '@/hooks/useIfcLoader';
import { downloadFile } from '@/lib/export/download';
import { DEMO_REVISIONS, PILOT_QUERY, pilotDocument, pilotModel } from './demo';
import { useSemanticSession, savedSemanticWorkspace } from './session';
import { liveEntities } from './viewer';
import { queryForSelection } from './related-query';
import { validateInWorker } from './validation-worker';
import type { ValidationJob, ValidationOutput } from './validation-job';

export interface SourceInput { mode: string; payload: string; endpoint: string; host: string; query: string; mapping: BindingMapping; bearer?: string; relayProvider?: string }
export type ValidationExecutor = (job: ValidationJob, signal: AbortSignal) => Promise<ValidationOutput>;
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
    const validated = await execute({ ...job, profile }, signal);
    if (signal.aborted || useSemanticSession.getState().profile !== profile) return;
    if (guard && !guard()) throw new Error('Loaded models changed during retrieval; load the records again');
    setDocument(validated.document); setGraph(validated.graph); session.setGraphFormat('application/n-quads'); setResults(bindings); setFindings(validated.findings); setDiagnostic(validated.diagnostic ?? "");
  }
  function load(input: SourceInput) {
    return run(async signal => {
      const models = useViewerStore.getState().models; const guard = () => models === useViewerStore.getState().models && useSemanticSession.getState().profile === profile;
      if (input.mode === 'turtle' || input.mode === 'nquads' || input.mode === 'jsonld') {
        const value = await execute({ graph: input.payload, profile, graphFormat: input.mode === 'turtle' ? 'text/turtle' : input.mode === 'nquads' ? 'application/n-quads' : 'application/ld+json' }, signal);
        if (!signal.aborted && guard()) { setGraph(value.graph); session.setGraphFormat('application/n-quads'); setDocument(undefined); setResults(undefined); setFindings(value.findings); setDiagnostic(value.diagnostic ?? ""); }
        else if (!signal.aborted) throw new Error('Loaded models changed during graph import');
        return;
      }
      if (input.mode === 'local') {
        if (new TextEncoder().encode(input.payload).length > 5 * 1024 * 1024) throw new Error('JSON exceeds the byte limit');
        const validated = await execute({ document: JSON.parse(input.payload) as unknown, profile }, signal);
        if (!signal.aborted && guard()) { setDocument(validated.document); setGraph(validated.graph); setFindings(validated.findings); setDiagnostic(validated.diagnostic ?? ""); setResults(undefined); }
        else if (!signal.aborted) throw new Error('Loaded models changed during import');
        if (!signal.aborted && useSemanticSession.getState().profile === profile) session.setRetrievedAt(undefined); return;
      }
      const kind = input.mode === 'json' ? 'json' : input.mode === 'construct' ? 'construct' : 'select';
      const response = await createSemanticProvider().read({ ...input, kind }, signal);
      if (signal.aborted) return;
      if (!guard()) throw new Error('Loaded models changed during retrieval; load the records again');
      session.setRetrievedAt(response.retrievedAt);
      session.setQueries([{ id: 'current', endpoint: input.endpoint, kind, query: input.query, mapping: input.mapping, profileId: profile.id }]);
      if (response.kind === 'select') {
        // Generic results are committed independently; a narrower projection may fail visibly.
        setResults(response.value); setDocument(undefined); setGraph(''); setFindings([]);
        try { await accept({ results: response.value, source: response.source, mapping: input.mapping }, signal, response.value, guard); }
        catch (failure) { if (!signal.aborted) setDiagnostic(failure instanceof Error ? failure.message : String(failure)); }
      } else if (response.kind === 'construct') {
        setGraph(response.value); session.setGraphFormat('text/turtle'); setDocument(undefined); setResults(undefined); setFindings([]);
        try {
          const validated = await execute({ graph: response.value, profile }, signal);
          if (!signal.aborted && guard()) { setFindings(validated.findings); setDiagnostic(validated.diagnostic ?? ""); }
          else if (!signal.aborted) throw new Error('Loaded models changed during validation');
        } catch (failure) { if (!signal.aborted) setDiagnostic(failure instanceof Error ? failure.message : String(failure)); }

      } else {
        const validated = await execute({ document: response.value, profile }, signal);
        if (!signal.aborted && guard()) { setDocument(validated.document); setGraph(validated.graph); setFindings(validated.findings); setDiagnostic(validated.diagnostic ?? ""); setResults(undefined); }
        else if (!signal.aborted) throw new Error('Loaded models changed during validation');
      }
    });
  }
  function related(input: SourceInput) {
    try {
      const query = queryForSelection({ selection: createSelectionAdapter(useViewerStore).get(), entities: liveEntities(),
        revisions, profile, mapping: input.mapping, document, results, settings: session });
      return load({ ...input, mode: 'sparql', query, mapping: DEFAULT_MAPPING });
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
      await accept({ document: pilotDocument() }, signal); session.setRetrievedAt(undefined);
    });
  }
  function validate(suppliedGraph = false) {
    return run(async signal => {
      const value = await execute(suppliedGraph ? { graph, profile } : { document, profile }, signal);
      if (!signal.aborted && useSemanticSession.getState().profile === profile) { setFindings(value.findings); setDiagnostic(value.diagnostic ?? ""); }
    });
  }
  function exportBundle() {
    return run(async signal => {
      const assets = await generateArtifacts(profile);
      const bundle = { document, ...assets, jsonLd: document ? asJsonLd(document, profile) : undefined, nquads: graph,
        selectQuery: PILOT_QUERY, sparqlResults: results, note: 'Original reference profile; no standards conformity claim.' };
      if (!signal.aborted) downloadFile(JSON.stringify(bundle, null, 2), 'semantic-records.json', 'application/json');
    });
  }
  function saveWorkspace() { try { downloadFile(session.save(), 'semantic-workspace.json', 'application/json'); } catch (failure) { setError(String(failure)); } }
  function restoreWorkspace(serialized?: string) {
    try { const value = serialized ?? savedSemanticWorkspace(); if (!value) throw new Error('No saved workspace'); current.current?.abort(); session.restore(value); }
    catch (failure) { setError(String(failure)); }
  }
  return { ...session, busy, error, diagnostic, setError, load, related, demo, validate, exportBundle, saveWorkspace, restoreWorkspace,
    cancel: () => current.current?.abort() };
}
