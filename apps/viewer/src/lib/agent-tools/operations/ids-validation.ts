/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { operation, viewerOperation, emptySchema } from './contract';
import { assertToolActive } from '../cancellation';
import type { ValidationReport } from '@ifc-lite/ids';
import type { IdsReportBlock } from '@/lib/document/ids-report-types';
import type { ToolHost } from '../types';
import { evictOldest } from './host-handles';
import { boundedPage, pageInput, type PageInput } from './result-limit';
import { libraryPage } from './library-page';
import { assertRevision, revisionInput, stateRevision } from './state-revision';
import { internal, invalidInput, stale, unavailable, parseJsonInput, decodedInput } from './refusals';
const jsonOutput = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const artifactOutput = { type: 'object', properties: { artifact_id: { type: 'string' }, filename: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer' } }, required: ['artifact_id', 'filename', 'mime_type', 'bytes'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, description: string, effect: 'read' | 'configuration' | 'artifact' = 'read') => ({ id, owner: 'validation', description, effects: [effect],
  capability: effect === 'read' ? 'read' as const : 'commands-and-edits' as const, implementation: 'native-store' as const, outputSchema: effect === 'artifact' ? artifactOutput : jsonOutput,
  policy: effect === 'artifact' ? { artifact: 'native-export' as const } : undefined });
type ViewerState = ReturnType<typeof useViewerStore.getState>;
/** What a run's findings depend on. Information rules also read model tag ids, tag assignments and grouping lenses,
 * so re-tagging a model or editing a grouping changes their findings as an edit does; IDS runs read none of them.
 * Tags and lenses are compared by what the rule engine reads, so renaming a tag or recolouring a lens changes nothing. */
interface RunInputs { models: ViewerState['models']; mutationVersion: number; tagIds?: string; modelTagAssignments?: ViewerState['modelTagAssignments']; groupings?: string }
/** Loaded by `validation.rules.run`, the only operation that records a rules run, so it is set before any rules run is
 * compared. A static import of the lens module would split it out of the eager chunk. */
let isGroupingLens: typeof import('@/lib/model-tags/evaluator-models').isGroupingLens | undefined;
const groupingLens = () => { if (!isGroupingLens) throw internal('Validation rules are not loaded. Run the check again.'); return isGroupingLens; };
/** The fields `customGroupingsFromLenses` hands the rule engine. */
const groupingsSignature = (lenses: ViewerState['savedLenses']) => JSON.stringify(lenses.filter(groupingLens()).map(lens => [lens.id, lens.name,
  lens.capturedScope ?? null, lens.rules.map(rule => [rule.name, rule.enabled, rule.unreadableLegacy ? null : rule.groups ?? null])]));
type RunKind = 'rules' | 'ids';
const runInputs = (s: ViewerState, kind: RunKind): RunInputs => ({ models: s.models, mutationVersion: s.mutationVersion,
  ...(kind === 'rules' ? { tagIds: JSON.stringify([...s.modelTags.keys()].sort()), modelTagAssignments: s.modelTagAssignments, groupings: groupingsSignature(s.savedLenses) } : {}) });
/** `run` holds only the inputs its kind read; each is compared with the current state. */
const sameInputs = (run: RunInputs, now: RunInputs) => (Object.keys(run) as (keyof RunInputs)[]).every(key => run[key] === now[key]);
/** `source` is the model the run evaluated: a single-model session replaces its store without changing `models`. */
interface Run { report: ValidationReport; snapshot: IdsReportBlock; kind: RunKind; inputs: RunInputs; source: { modelId: string; store: unknown } }
const hosts = new WeakMap<ToolHost, Map<string, Run>>();
function runs(c: { host: ToolHost }) { let values = hosts.get(c.host); if (!values) { values = new Map(); hosts.set(c.host, values); const captured = values; c.host.lifetimeSignal?.addEventListener('abort', () => captured.clear(), { once: true }); } return values; }
function run(c: { host: ToolHost }, id: string) { const value = runs(c).get(id); if (!value) throw invalidInput('unknown-target', 'Unknown validation run owned by this host.');
  if (!sameInputs(value.inputs, runInputs(useViewerStore.getState(), value.kind))
    || c.host.models().find(model => model.id === value.source.modelId)?.store !== value.source.store) throw stale('Validation inputs changed. Run the check again.');
  return value;
}
function libraryRevision(expected: number) { if (useViewerStore.getState().validationDefinitionRevision !== expected) throw stale('Validation definitions changed. Inspect them again.'); }
const runInput = { type: 'object' as const, properties: { run_id: { type: 'string' as const, minLength: 1, maxLength: 100 } }, required: ['run_id' as const], additionalProperties: false as const };
export const nativeValidationOperations = [
  viewerOperation(meta('validation.state', 'Inspect current native IDS/rule definitions, active drafts, definition revision and live report summary.'), emptySchema, () => {
    const s = useViewerStore.getState(); return out({ definitions: s.validationDefinitions, revision: s.validationDefinitionRevision, errors: s.validationDefinitionsError,
      ruleDraft: s.validationRuleSetDraft, ruleEditing: s.validationRuleSetEditing, idsDocument: s.idsDocument, reportSummary: s.idsValidationReport?.summary ?? null });
  }),
  viewerOperation<{ action: 'rules.import' | 'ids.import' | 'activate' | 'remove' | 'deactivate' | 'rules.draft'; id: string; kind: 'rules' | 'ids'; content: string; definition_revision: number }>(meta('validation.definitions.write', 'Import/replace/select/remove a native check definition or edit the active rule draft using its authoritative parser and definition-library writer. Empty id creates a new imported definition.', 'configuration'), {
    type: 'object', properties: { action: { type: 'string', enum: ['rules.import', 'ids.import', 'activate', 'remove', 'deactivate', 'rules.draft'] }, id: { type: 'string', maxLength: 200 }, kind: { type: 'string', enum: ['rules', 'ids'] }, content: { type: 'string', maxLength: 1000000 }, definition_revision: { type: 'integer', minimum: 0 } },
    required: ['action', 'id', 'kind', 'content', 'definition_revision'], additionalProperties: false,
  }, async (i, c) => {
    const [{ parseRuleSetFile }, { parseIDS }] = await Promise.all([import('@ifc-lite/rules'), import('@ifc-lite/ids')]);
    assertToolActive(c); libraryRevision(i.definition_revision);
    if (i.action === 'rules.import' || i.action === 'rules.draft') {
      const parsed = parseRuleSetFile(parseJsonInput(i.content, 'content')); if (!parsed.ok) throw invalidInput('invalid-value', parsed.error);
      return out(c.commit(() => { libraryRevision(i.definition_revision); const s = useViewerStore.getState();
        if (i.action === 'rules.draft') s.setValidationRuleSetDraft(parsed.file);
        else if (!s.addValidationDefinition({ kind: 'rules', file: parsed.file }, i.id || undefined)) throw invalidInput('refused', s.validationDefinitionsError ?? 'Native definition save refused.');
        return { revision: useViewerStore.getState().validationDefinitionRevision, storageError: useViewerStore.getState().validationDefinitionsError };
      }));
    }
    if (i.action === 'ids.import') {
      const document = decodedInput('content', () => parseIDS(i.content)); return out(c.commit(() => { libraryRevision(i.definition_revision); const s = useViewerStore.getState();
        if (!s.addValidationDefinition({ kind: 'ids', xml: i.content, document }, i.id || undefined)) throw invalidInput('refused', s.validationDefinitionsError ?? 'Native IDS definition refused.');
        return { revision: useViewerStore.getState().validationDefinitionRevision, storageError: useViewerStore.getState().validationDefinitionsError };
      }));
    }
    return out(c.commit(() => { libraryRevision(i.definition_revision); const s = useViewerStore.getState();
      if (i.action !== 'deactivate' && !s.validationDefinitions.entries.some(entry => entry.id === i.id)) throw invalidInput('unknown-target', 'Unknown native validation definition.');
      if (i.action === 'activate') s.selectValidationDefinition(i.id); else if (i.action === 'remove') s.removeValidationDefinition(i.id); else s.deactivateValidationDefinition(i.kind);
      return { revision: useViewerStore.getState().validationDefinitionRevision, storageError: useViewerStore.getState().validationDefinitionsError };
    }));
  }),
  operation<{ xml: string; scope: 'whole' | 'subset'; entity_ids: number[] }>(meta('validation.ids.run', 'Execute canonical IDS XML through the panel’s shared native IDS runner, including pending edits and explicit whole/subset scope. Produces the same revision-bound run handles as information rules.'), {
    type: 'object', properties: { xml: { type: 'string', minLength: 1, maxLength: 1000000 }, scope: { type: 'string', enum: ['whole', 'subset'] }, entity_ids: { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'integer', minimum: 1 } } }, required: ['xml', 'scope', 'entity_ids'], additionalProperties: false,
  }, async (i, c) => {
    const [{ parseIDS }, { runIdsCheck }, { resolveRef }] = await Promise.all([import('@ifc-lite/ids'), import('@/lib/validation/run-ids-check'), import('../refs')]);
    const document = decodedInput('xml', () => parseIDS(i.xml)); for (const express_id of i.entity_ids) resolveRef(c.model, { express_id });
    assertToolActive(c); const state = useViewerStore.getState(), inputs = runInputs(state, 'ids');
    const result = await runIdsCheck({ document, modelId: c.model.id, dataStore: c.model.store, mutationView: c.model.mutationView(), locale: 'en', models: state.models, signal: c.signal,
      ...(i.scope === 'subset' ? { entityIds: i.entity_ids } : {}) });
    assertToolActive(c); if (!sameInputs(inputs, runInputs(useViewerStore.getState(), 'ids'))) throw stale('Models changed during IDS validation.');
    if (c.host.models().find(model => model.id === c.model.id)?.store !== c.model.store) throw stale('Models changed during IDS validation.');
    evictOldest(runs(c), 32); const id = crypto.randomUUID(); runs(c).set(id, { ...result, kind: 'ids', inputs, source: { modelId: c.model.id, store: c.model.store } });
    return out({ run_id: id, summary: result.report.summary, source: result.report.source });
  }),
  operation<{ express_ids: number[]; pset: string; name: string; facet_data_type: string; raw_value: string; title: string }>(meta('validation.fix.prepare', 'Draft a native IDS property correction from explicit target IDs and a supplied raw value. Uses native type inference, IDS-to-model unit conversion and expected-value capture, then the existing properties review/apply service.'), {
    type: 'object', properties: { express_ids: { type: 'array', maxItems: 1000, minItems: 1, items: { type: 'integer', minimum: 1 } }, pset: { type: 'string', minLength: 1, maxLength: 200 }, name: { type: 'string', minLength: 1, maxLength: 200 }, facet_data_type: { type: 'string', maxLength: 100 }, raw_value: { type: 'string', maxLength: 2000 }, title: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['express_ids', 'pset', 'name', 'facet_data_type', 'raw_value', 'title'], additionalProperties: false,
  }, async (i, c) => {
    const [{ idsCorrectionToModelChanges }, { preparePropertyCandidates }, { resolveRef }] = await Promise.all([import('@/lib/actions/ids-changes'), import('./authoring-native'), import('../refs')]);
    for (const express_id of i.express_ids) resolveRef(c.model, { express_id }); assertToolActive(c);
    const converted = idsCorrectionToModelChanges(useViewerStore.getState(), { modelId: c.model.id, target: { psetName: i.pset, propName: i.name }, expressIds: i.express_ids, rawValue: i.raw_value, title: i.title,
      ...(i.facet_data_type ? { facetDataType: i.facet_data_type } : {}) });
    // All batches or none: every batch is previewed before any is admitted, then all are admitted in one step.
    const candidates = await preparePropertyCandidates(c, converted.batches.map(batch => JSON.stringify(batch)), 'pset, name, raw_value, facet_data_type or title');
    return out({ converted, candidates });
  }),
  operation<{ rules_json: string; model_ids: string[] }>(meta('validation.rules.run', 'Run a canonical information-rule definition over an explicit loaded model population through the shared native rule executor. Pending edits are materialized by its canonical effective-store path. Returns a host-owned, revision-bound run handle; native cancellation is forwarded.'), {
    type: 'object', properties: { rules_json: { type: 'string', maxLength: 1000000 }, model_ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } } }, required: ['rules_json', 'model_ids'], additionalProperties: false,
  }, async (i, c) => {
    const [{ parseRuleSetFile }, { runInformationCheck }, evaluator] = await Promise.all([
      import('@ifc-lite/rules'), import('@/lib/validation/run-information-check'), import('@/lib/model-tags/evaluator-models'),
    ]);
    const { evaluatorModelsFromState, definedModelTagIdsOf } = evaluator; isGroupingLens = evaluator.isGroupingLens;
    const parsed = parseRuleSetFile(parseJsonInput(i.rules_json, 'rules_json')); if (!parsed.ok) throw invalidInput('invalid-value', parsed.error); assertToolActive(c);
    const s = useViewerStore.getState(), models = evaluatorModelsFromState(s).filter(model => i.model_ids.includes(model.id));
    if (models.length !== i.model_ids.length || !i.model_ids.includes(c.model.id)) throw invalidInput('wrong-target', 'Every explicit model must be currently loaded, and include the selected model.');
    const inputs = runInputs(s, 'rules');
    const result = await runInformationCheck({ ruleSet: parsed.file, models, definedModelTagIds: definedModelTagIdsOf(s), reportModels: s.models, signal: c.signal });
    assertToolActive(c); if (!sameInputs(inputs, runInputs(useViewerStore.getState(), 'rules'))) throw stale('Models changed during validation. Discarded result.');
    if (c.host.models().find(model => model.id === c.model.id)?.store !== c.model.store) throw stale('Models changed during validation. Discarded result.');
    evictOldest(runs(c), 32); const id = crypto.randomUUID(); runs(c).set(id, { ...result, kind: 'rules', inputs, source: { modelId: c.model.id, store: c.model.store } });
    return out({ run_id: id, summary: result.report.summary, source: result.report.source });
  }),
  operation<PageInput & { run_id: string; offset: number; limit: number }>(meta('validation.results', 'Inspect a bounded page of canonical native specification findings, preserving complete native entity/requirement diagnostics in each returned specification. Pass next_offset and page_revision to continue.'), {
    type: 'object', properties: { ...runInput.properties, ...pageInput.properties, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['run_id', 'offset', 'limit'], additionalProperties: false,
  }, (i, c) => {
    const { report } = run(c, i.run_id);
    const header = { summary: report.summary };
    const { items: results, ...page } = boundedPage(report.specificationResults, i, header);
    return out({ ...header, ...page, results });
  }),
  operation<{ run_id: string }>(meta('validation.publish', 'Publish an exact current native run into the existing Validation-panel report slot, without rerunning or reinterpreting its findings.', 'configuration'), runInput, async (i, c) => {
    const { captureAnalysisStamp, stampAnalysisReport } = await import('@/hooks/useAnalysisStaleness'); assertToolActive(c);
    return out(c.commit(() => { const value = run(c, i.run_id); useViewerStore.getState().setIdsValidationReport(stampAnalysisReport(value.report, captureAnalysisStamp(true))); return { published: i.run_id, summary: value.report.summary }; }));
  }),
  operation<{ run_id: string; format: 'json' | 'html' }>(meta('validation.report.export', 'Render the exact native run through the panel’s shared JSON/HTML report writers into a host-owned artifact.', 'artifact'), {
    type: 'object', properties: { ...runInput.properties, format: { type: 'string', enum: ['json', 'html'] } }, required: ['run_id', 'format'], additionalProperties: false,
  }, async (i, c) => {
    const { buildReportJSON, buildReportHTML } = await import('@/hooks/ids/idsExportService'); assertToolActive(c); const value = run(c, i.run_id);
    const data = i.format === 'json' ? JSON.stringify(buildReportJSON(value.report), null, 2) : buildReportHTML(value.report, 'en');
    return c.artifacts.create({ filename: `validation-report.${i.format}`, mimeType: i.format === 'json' ? 'application/json' : 'text/html', data });
  }),
  operation<{ run_id: string; topic_grouping: 'per-entity' | 'per-specification'; include_passing: boolean; include_camera: boolean; include_snapshots: boolean }>(meta('validation.report.bcf', 'Export an exact current native report through the existing BCF pipeline into a host artifact. Native topic caps and snapshot failures stay explicit. Cancellation stops publication; a capture already running may finish.', 'artifact'), {
    type: 'object', properties: { ...runInput.properties, topic_grouping: { type: 'string', enum: ['per-entity', 'per-specification'] }, include_passing: { type: 'boolean' }, include_camera: { type: 'boolean' }, include_snapshots: { type: 'boolean' } }, required: ['run_id', 'topic_grouping', 'include_passing', 'include_camera', 'include_snapshots'], additionalProperties: false,
  }, async (i, c) => {
    const { runIdsBcfExport } = await import('@/hooks/ids/idsBcfExport'); const value = run(c, i.run_id), s = useViewerStore.getState(); assertToolActive(c);
    let captured: { blob: Blob; filename: string } | undefined;
    await runIdsBcfExport({ report: value.report, settings: { topicGrouping: i.topic_grouping, includePassingEntities: i.include_passing, includeCamera: i.include_camera, includeSnapshots: i.include_snapshots, loadIntoBcfPanel: false },
      models: s.models, legacyGeometryResult: s.geometryResult, bcfAuthor: s.bcfAuthor, toViewerGlobalId: (modelId, expressId) => s.models.has(modelId) ? s.toGlobalId(modelId, expressId) : undefined,
      setBcfExportProgress: () => undefined, setBcfProject: s.setBcfProject, setBcfPanelVisible: s.setBcfPanelVisible, signal: c.signal,
      emit: (blob, filename) => { captured = { blob, filename }; } });
    assertToolActive(c); run(c, i.run_id); if (!captured) throw internal('The native BCF exporter produced no artifact.');
    return c.artifacts.create({ filename: captured.filename, mimeType: 'application/zip', data: captured.blob });
  }),
  operation<{ run_id: string; name: string }>(meta('validation.report.save', 'Save an exact current validation result through the native durable report library.', 'configuration'), {
    type: 'object', properties: { ...runInput.properties, name: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['run_id', 'name'], additionalProperties: false,
  }, async (i, c) => { const value = run(c, i.run_id); const id = await c.commitAsync(() => useViewerStore.getState().saveValidationReport(value.snapshot, i.name), saved => !!saved);
    if (!id) throw internal('Native report persistence failed.'); return out({ id }); }),
  viewerOperation<PageInput>(meta('validation.reports.read', 'Read the native durable report library, one page at a time (pass next_offset as offset with the page_revision of the previous page until next_offset is null; a list that changed in between is refused, so read again from 0), and its persistence diagnostics with no model required. expected_reports is the whole library revision. storage summarizes the whole library (phase, recovered, entry_count, counts by save state) and maps the ids on this page to their save states; save states of removed entries page after the entries. Historical evidence never installs old entity IDs into the scene.'), pageInput, async (i, c) => {
    await useViewerStore.getState().initializeValidationReports(); assertToolActive(c); const s = useViewerStore.getState();
    const expected_reports = stateRevision(s.savedValidationReports), { entries: reports, page, storage } = libraryPage(s.savedValidationReports, s.validationReportsStorage, i, { expected_reports });
    return out({ reports, ...page, expected_reports, storage });
  }),
  viewerOperation<{ action: 'rename' | 'remove' | 'reuseManual' | 'restore' | 'retry'; id: string; name: string; expected_reports: string }>(meta('validation.reports.manage', 'Rename/remove saved native reports, restore/retry native durable storage or create an independent editable copy of an eligible saved Manual report. Native fingerprint eligibility remains authoritative.', 'configuration'), {
    type: 'object', properties: { action: { type: 'string', enum: ['rename', 'remove', 'reuseManual', 'restore', 'retry'] }, id: { type: 'string', maxLength: 200 }, name: { type: 'string', maxLength: 200 }, expected_reports: revisionInput }, required: ['action', 'id', 'name', 'expected_reports'], additionalProperties: false,
  }, async (i, c) => {
    const expected = () => assertRevision(useViewerStore.getState().savedValidationReports, i.expected_reports, 'The native report library changed. Inspect again.');
    expected(); const s = useViewerStore.getState();
    if (i.action === 'reuseManual') {
      const report = s.savedValidationReports.find(row => row.id === i.id); if (!report) throw invalidInput('unknown-target', 'Unknown saved native report.');
      c.commit(() => { expected(); if (!s.reuseManualValidationReport(report)) throw unavailable('Native manual report reuse is unavailable for the current fingerprints.'); });
      return out({ reused: i.id });
    }
    const result = await c.commitAsync(() => { expected(); if (i.action === 'restore') return s.restoreValidationReports(); if (i.action === 'retry') return s.retryValidationReportsSave();
      if (!s.savedValidationReports.some(row => row.id === i.id)) throw invalidInput('unknown-target', 'Unknown saved native report.');
      return i.action === 'rename' ? s.renameValidationReport(i.id, i.name) : s.removeValidationReport(i.id);
    }, done => !!done); if (!result) throw internal('Native report storage operation failed.'); return out({ completed: true });
  }),
];
