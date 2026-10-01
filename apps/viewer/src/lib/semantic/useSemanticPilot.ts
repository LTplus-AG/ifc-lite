/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useIfcLoader } from '@/hooks/useIfcLoader';
import { downloadFile } from '@/lib/export/download';
import { DEMO_REVISIONS, PILOT_QUERY, pilotDocument, pilotModel } from './demo';
import { context, dictionary, exchangeSchema, shapesTurtle, vocabularyTurtle } from './profile';
import { parseResults, request, resourcesFromResults } from './transport';
import { asJsonLd, parseImport, toRdf, validateGraph, validateJson, validateLinks } from './validation';
import type { BindingMapping, SemanticDocument, SparqlResults } from './types';
import { useSemanticSession } from './session';

export function useSemanticPilot() {
  const { document, setDocument, results, setResults, findings, setFindings,
    graph, setGraph, revisions, setRevisions } = useSemanticSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<AbortController | null>(null);
  const { loadFile } = useIfcLoader();
  useEffect(() => () => current.current?.abort(), []);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    setBusy(true); setError('');
    try { await action(controller.signal); }
    catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (current.current === controller) { setBusy(false); current.current = null; }
    }
  }
  async function accept(next: SemanticDocument, signal: AbortSignal, bindings?: SparqlResults, modelGuard?: () => boolean) {
    const rdf = await toRdf(next);
    const validation = [...validateJson(next), ...validateLinks(next), ...await validateGraph(rdf)];
    if (signal.aborted) return;
    if (modelGuard && !modelGuard()) throw new Error('Loaded models changed during retrieval; load the records again');
    setDocument(next); setGraph(rdf); setResults(bindings); setFindings(validation);
  }
  function load(input: { mode: string; payload: string; endpoint: string; host: string; query: string; mapping: BindingMapping }) {
    return run(async signal => {
      const models = useViewerStore.getState().models;
      if (input.mode === 'local' && input.payload.length > 5 * 1024 * 1024) throw new Error('JSON exceeds the pilot limit');
      const data: unknown = input.mode === 'local' ? JSON.parse(input.payload)
        : await request(input.endpoint, input.host, signal, input.mode === 'sparql' ? input.query : undefined);
      if (signal.aborted) return;
      if (models !== useViewerStore.getState().models) throw new Error('Loaded models changed during retrieval; load the records again');
      const bindings = input.mode === 'sparql' ? parseResults(data) : undefined;
      await accept(bindings ? resourcesFromResults(bindings, input.endpoint, input.mapping) : parseImport(data), signal, bindings,
        () => models === useViewerStore.getState().models);
      // Loading does not cache IFC addresses; every later action resolves anew.
    });
  }
  function demo(withModels: boolean) {
    return run(async signal => {
      if (withModels) {
        const associations = new Map<string, string>();
        for (let index = 0; index < 2; index++) {
          if (signal.aborted) return;
          const modelId = crypto.randomUUID();
          await loadFile(new File([pilotModel(index).content], `semantic-pilot-${index + 1}.ifc`),
            { kind: 'federated', modelId, name: `Linked records pilot ${index + 1}` });
          const loaded = useViewerStore.getState().models.get(modelId);
          if (!loaded?.ifcDataStore || loaded.loadState === 'error') throw new Error('Pilot model failed to load');
          associations.set(DEMO_REVISIONS[index], modelId);
        }
        if (signal.aborted) return;
        setRevisions(associations);
      }
      await accept(pilotDocument(), signal);
    });
  }
  function validate(suppliedGraph = false) {
    return run(async signal => {
      const validation = suppliedGraph ? await validateGraph(graph)
        : document ? [...validateJson(document), ...validateLinks(document), ...await validateGraph(await toRdf(document))] : [];
      if (!signal.aborted) setFindings(validation);
    });
  }
  function exportBundle() {
    return run(async signal => {
      if (!document) return;
      const bundle = { document, jsonSchema: exchangeSchema, jsonLd: asJsonLd(document), context,
        shapesTurtle: await shapesTurtle(), vocabularyTurtle: await vocabularyTurtle(), dictionary,
        nquads: await toRdf(document), selectQuery: PILOT_QUERY,
        revisionAssociations: Object.fromEntries(revisions), sparqlResults: results,
        note: 'Original demonstration profile; no standards conformity claim. Associations are session-specific.' };
      if (!signal.aborted) downloadFile(JSON.stringify(bundle, null, 2), 'semantic-pilot.json', 'application/json');
    });
  }
  return { document, results, findings, graph, setGraph, revisions, setRevisions, busy, error, setError,
    load, demo, validate, exportBundle, cancel: () => { current.current?.abort(); } };
}
