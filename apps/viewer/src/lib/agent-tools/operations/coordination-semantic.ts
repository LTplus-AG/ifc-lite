/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useSemanticSession } from '@/lib/semantic/session';
import { validateCurrentSemantic } from '@/lib/semantic/validate-current';
import { emptySchema } from './contract';
import { coordination, textSchema, boolSchema } from './coordination-common';
import { invalidInput } from './refusals';
const workspaceSchema = {
  ...textSchema,
  properties: { value: { type: 'string' as const, maxLength: 5 * 1024 * 1024 } },
};
export const coordinationSemanticOperations = [
  coordination('semantic.read', 'Read native semantic dataset, validation findings, profile and model-revision bindings.', ['read'], emptySchema, () => {
    const s = useSemanticSession.getState(); return { document: s.document, graph: s.graph, graph_format: s.graphFormat,
      results: s.results, findings: s.findings, report: s.report, profile: s.profile, data_version: s.dataVersion,
      revisions: [...s.revisions], strategy: s.strategy, retrieved_at: s.retrievedAt };
  }),
  coordination('semantic.graph', 'Replace the native editable RDF graph and invalidate prior validation evidence.', ['configuration'], textSchema, (i, c) => c.commit(() => { useSemanticSession.getState().setGraph(i.value); return { data_version: useSemanticSession.getState().dataVersion }; })),
  coordination<{ format: 'text/turtle' | 'application/n-quads' }>('semantic.graphFormat', 'Set native RDF parser format and invalidate prior validation evidence.', ['configuration'], {
    type: 'object', properties: { format: { type: 'string', enum: ['text/turtle', 'application/n-quads'] } }, required: ['format'], additionalProperties: false,
  }, (i, c) => c.commit(() => { useSemanticSession.getState().setGraphFormat(i.format); return { graph_format: useSemanticSession.getState().graphFormat, data_version: useSemanticSession.getState().dataVersion }; })),
  coordination<{ revision: string; model_id: string }>('semantic.bindRevision', 'Bind a semantic model revision to an exact loaded native model id.', ['configuration'], {
    type: 'object', properties: { revision: { type: 'string', minLength: 1, maxLength: 2000 }, model_id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['revision', 'model_id'], additionalProperties: false,
  }, async (i, c) => {
    const { useViewerStore } = await import('@/store');
    return c.commit(() => {
      const model = useViewerStore.getState().models.get(i.model_id); if (!model) throw invalidInput('unknown-target', 'Unknown model_id.'); if (!model.ifcDataStore) throw invalidInput('wrong-target', 'Revision binding requires a loaded IFC model.');
      const session = useSemanticSession.getState(), revisions = new Map(session.revisions); revisions.set(i.revision, i.model_id); session.setRevisions(revisions); return { revisions: [...revisions] };
    });
  }),
  coordination('semantic.validate', 'Validate the current RDF graph (true) or imported document (false) through the panel worker. Awaits actual validation and rejects changed datasets.', ['configuration'], boolSchema, async (i, c) => {
    const signal = c.signal ?? new AbortController().signal;
    return validateCurrentSemantic(i.value, signal, undefined, write => c.commit(write));
  }),
  coordination('semantic.restoreWorkspace', 'Restore a serialized native workspace using its strict portable codec; credentials and runtime model bindings are excluded by that codec.', ['configuration'], workspaceSchema, (i, c) => c.commit(() => { useSemanticSession.getState().restore(i.value); return { restored: true, data_version: useSemanticSession.getState().dataVersion }; })),
  coordination('semantic.exportWorkspace', 'Save a portable semantic workspace through the native codec and return a JSON artifact.', ['configuration', 'artifact'], emptySchema, async (_, c) => {
    const data = c.commit(() => useSemanticSession.getState().save());
    return c.artifacts.create({ filename: 'semantic-workspace.json', mimeType: 'application/json', data });
  }),
];
