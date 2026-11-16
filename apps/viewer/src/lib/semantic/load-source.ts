/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createSemanticProvider, type BindingMapping, type SparqlResults } from '@ifc-lite/semantic';
import { useViewerStore } from '@/store';
import { useSemanticSession } from './session';
import { validateInWorker } from './validation-worker';
import type { ValidationJob, ValidationOutput } from './validation-job';
export interface SourceInput { mode: string; payload: string; endpoint: string; host: string; query: string; mapping: BindingMapping; bearer?: string; relayProvider?: string; loopbackHttpOrigin?: string }
export type ValidationExecutor = (job: ValidationJob, signal: AbortSignal) => Promise<ValidationOutput>;
/** Native source retrieval/validation, shared by the panel and automation. Credentials are request-local. */
export async function loadSemanticSource(input: SourceInput, signal: AbortSignal, execute: ValidationExecutor = validateInWorker, onRetrieved?: () => void, commit: <T>(write: () => T) => T = write => write()) {
  const initial = useSemanticSession.getState(), profile = initial.profile;
  let diagnostic = ''; const setDiagnostic = (value: string) => { diagnostic = value; };
  const setDocument: typeof initial.setDocument = value => commit(() => initial.setDocument(value));
  const setGraph: typeof initial.setGraph = value => commit(() => initial.setGraph(value));
  const setResults: typeof initial.setResults = value => commit(() => initial.setResults(value));
  const setFindings: typeof initial.setFindings = value => commit(() => initial.setFindings(value));
  const session = { ...initial,
    setGraphFormat: (value: Parameters<typeof initial.setGraphFormat>[0]) => commit(() => initial.setGraphFormat(value)),
    setReport: (value: Parameters<typeof initial.setReport>[0]) => commit(() => initial.setReport(value)),
    setRetrievedAt: (value: Parameters<typeof initial.setRetrievedAt>[0]) => commit(() => initial.setRetrievedAt(value)),
    setQueries: (value: Parameters<typeof initial.setQueries>[0]) => commit(() => initial.setQueries(value)),
    setResultMapping: (value: Parameters<typeof initial.setResultMapping>[0]) => commit(() => initial.setResultMapping(value)),
  };
  async function accept(job: ValidationJob, signal: AbortSignal, bindings?: SparqlResults, guard?: () => boolean) {
    const inputVersion = useSemanticSession.getState().dataVersion;
    const validated = await execute({ ...job, profile }, signal);
    if (signal.aborted || useSemanticSession.getState().profile !== profile || useSemanticSession.getState().dataVersion !== inputVersion) return false;
    if (guard && !guard()) throw new Error('Loaded models changed during retrieval; load the records again');
    setDocument(validated.document); setGraph(validated.graph); session.setGraphFormat('application/n-quads'); setResults(bindings); setFindings(validated.findings); setDiagnostic(validated.diagnostic ?? ""); session.setReport(validated.diagnostic ? undefined : validated.report);
    return true;
  }
  async function load() {
      let inputVersion = useSemanticSession.getState().dataVersion;
      const models = useViewerStore.getState().models; const guard = () => inputVersion === useSemanticSession.getState().dataVersion && models === useViewerStore.getState().models && useSemanticSession.getState().profile === profile;
      if (input.mode === 'turtle' || input.mode === 'nquads' || input.mode === 'jsonld') {
        const value = await execute({ graph: input.payload, profile, graphFormat: input.mode === 'turtle' ? 'text/turtle' : input.mode === 'nquads' ? 'application/n-quads' : 'application/ld+json' }, signal);
        if (!signal.aborted && guard()) { setGraph(value.graph); session.setGraphFormat('application/n-quads'); setDocument(undefined); setResults(undefined); setFindings(value.findings); setDiagnostic(value.diagnostic ?? ""); session.setReport(value.diagnostic ? undefined : value.report); }
        else if (!signal.aborted) throw new Error('Loaded models changed during graph import');
        return;
      }
      if (input.mode === 'local') {
        if (new TextEncoder().encode(input.payload).length > 5 * 1024 * 1024) throw new Error('JSON exceeds the byte limit');
        const validated = await execute({ document: JSON.parse(input.payload) as unknown, profile }, signal);
        if (!signal.aborted && guard()) { setDocument(validated.document); setGraph(validated.graph); session.setGraphFormat('application/n-quads'); setFindings(validated.findings); setDiagnostic(validated.diagnostic ?? ""); session.setReport(validated.diagnostic ? undefined : validated.report); setResults(undefined); }
        else if (!signal.aborted) throw new Error('Loaded models changed during import');
        if (!signal.aborted && useSemanticSession.getState().profile === profile) session.setRetrievedAt(undefined); return;
      }
      const kind = input.mode === 'json' ? 'json' : input.mode === 'construct' ? 'construct' : 'select';
      const response = await createSemanticProvider().read({ ...input, kind }, signal);
      if (signal.aborted) return;
      if (!guard()) throw new Error('Loaded models changed during retrieval; load the records again');
      onRetrieved?.();
      session.setRetrievedAt(response.retrievedAt);
      session.setQueries([{ id: 'current', endpoint: input.endpoint, kind, query: input.query, mapping: input.mapping, profileId: profile.id }]);
      if (response.kind === 'select') {
        // Generic results are committed independently; a narrower projection may fail visibly.
        setResults(response.value); session.setResultMapping(input.mapping); setDocument(undefined); setGraph(''); setFindings([]);
        inputVersion = useSemanticSession.getState().dataVersion;
        try { await accept({ results: response.value, source: response.source, mapping: input.mapping }, signal, response.value, guard); }
        catch (failure) { if (!signal.aborted) setDiagnostic(failure instanceof Error ? failure.message : String(failure)); }
      } else if (response.kind === 'construct') {
        setGraph(response.value); session.setGraphFormat('text/turtle'); setDocument(undefined); setResults(undefined); setFindings([]);
        inputVersion = useSemanticSession.getState().dataVersion;
        try {
          const validated = await execute({ graph: response.value, profile }, signal);
          if (!signal.aborted && guard()) { setFindings(validated.findings); setDiagnostic(validated.diagnostic ?? ""); session.setReport(validated.diagnostic ? undefined : validated.report); }
          else if (!signal.aborted) throw new Error('Loaded models changed during validation');
        } catch (failure) { if (!signal.aborted) setDiagnostic(failure instanceof Error ? failure.message : String(failure)); }

      } else {
        const validated = await execute({ document: response.value, profile }, signal);
        if (!signal.aborted && guard()) { setDocument(validated.document); setGraph(validated.graph); session.setGraphFormat('application/n-quads'); setFindings(validated.findings); setDiagnostic(validated.diagnostic ?? ""); session.setReport(validated.diagnostic ? undefined : validated.report); setResults(undefined); }
        else if (!signal.aborted) throw new Error('Loaded models changed during validation');
      }
  }
  await load(); return { diagnostic, data_version: useSemanticSession.getState().dataVersion };
}
