/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { computeFullSourceHashFromBlob } from '@/utils/sourceContentHash';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '@ifc-lite/ids';
import { runIdsCheck } from '@/lib/validation/run-ids-check';
import { Rule, parseRuleSetFile, type RuleSetFile } from '@ifc-lite/rules';
import { AUTOMATION_FEATURES, type CheckJob, type SessionModels } from '@ifc-lite/flow-nodes';
import type { FlowDocument, HostFeatures } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { buildReportDocument, type DocumentReportResult } from '@/lib/document/build-report-document';
import { loadValidationReports, VALIDATION_REPORTS_STORAGE_KEY } from '@/lib/validation/reports/persistence';
import { validateChecks, compareChecks } from './check-host';
import { loadSavedComparisons } from '@/lib/compare/savedComparisonPersistence';
import { preflightWorkflow } from './preflight';
import { createAutomationHost } from './automation-host';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { checkedModelSet, checkWorkflowModelPins, loadSessionModels, assignSessionTags } from './local-models';
import { resolveModels } from './model-targets';
import { startWorkflowRun, isNativeWorkflowBusy, assertWorkflowOwner, type WorkflowRun } from './run-session';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#100=IFCWALL('0wall00000000000000000',$,'Wall A',$,$,$,$,$,.STANDARD.);
#101=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('NONE'),$);
#102=IFCPROPERTYSET('0pset00000000000000000',$,'Pset_WallCommon',$,(#101));
#103=IFCRELDEFINESBYPROPERTIES('0rel000000000000000000',$,$,$,(#100),#102);
ENDSEC;
END-ISO-10303-21;`;
function ruleSet(): RuleSetFile {
  return { version: 1, name: 'Walls require F90', rules: [{ id: 'fire-rating', name: 'Fire rating',
    applicability: { authoredAs: 'chips', groups: [{ combinator: 'AND', rules: [Rule.ifcType(['IfcWall'])] }] },
    requirement: { kind: 'element', block: { authoredAs: 'chips', groups: [{ combinator: 'AND', rules: [Rule.property('Pset_WallCommon', 'FireRating', 'eq', 'F90')] }] } },
  }] };
}
function job(value: RuleSetFile, overrides: Partial<CheckJob> = {}): CheckJob {
  return { id: 'check', enabled: true, source: { kind: 'embedded', value, name: 'Fire rating check' }, ...overrides };
}
async function seed() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer, { disableWorkerScan: true });
  const a = { ...fixtureModel('A'), name: 'structure.ifc', sourceContentHash: 'full-source-A', sourceFingerprint: 'source-A', ifcDataStore: store };
  const b = { ...fixtureModel('B', { idOffset: 1_000_000 }), name: 'services.ifc', sourceFingerprint: 'source-B', ifcDataStore: store };
  useViewerStore.setState({ ...fixtureModels(a, b), mutationViews: new Map(), mutationVersion: 0 });
}
function modelSet(run: WorkflowRun): SessionModels {
  return { runId: run.id, models: [
    { modelId: 'A', slotId: 'structure', filename: 'structure.ifc' },
    { modelId: 'B', slotId: 'services', filename: 'services.ifc' },
  ] };
}
const features: HostFeatures = { backend: new Set(AUTOMATION_FEATURES), network: false, secrets: new Set() };
function inputGraph(jobs: readonly CheckJob[]): FlowDocument {
  return { flowVersion: 2, id: 'automation-integration', name: 'Coordination',
    capabilities: ['model.create', 'model.read', 'storage.write:validationReports'],
    nodes: [
      { id: 'load', type: 'session.loadModels', params: { selectors: [] } },
      { id: 'checks', type: 'validation.runChecks', params: { jobs } },
    ], edges: [{ from: ['load', 'models'], to: ['checks', 'models'] }], outputs: [],
    inputs: [{ nodeId: 'load', param: 'files', label: 'Models', kind: 'files', fileSlots: [
      { id: 'models', label: 'Local IFC models', accept: '.ifc', multiple: true, required: true },
    ] }],
  };
}
let run: WorkflowRun | undefined;
beforeEach(async () => {
  localStorage.removeItem(VALIDATION_REPORTS_STORAGE_KEY);
  useViewerStore.setState({ savedValidationReports: [], validationReportsSaveFailed: false, modelTags: new Map(), modelTagAssignments: new Map() });
  await seed();
});
afterEach(() => {
  run?.release(); run = undefined;
  localStorage.removeItem(VALIDATION_REPORTS_STORAGE_KEY);
  useViewerStore.setState({ models: new Map(), activeModelId: null, savedValidationReports: [], modelTags: new Map(), modelTagAssignments: new Map() });
});

describe('session validation pipeline through native engines (#6612)', () => {
  it('retains failed quality evidence and builds an ordinary document without recoloring or publishing live results', async () => {
    run = startWorkflowRun();
    const previousLiveReport = useViewerStore.getState().idsValidationReport;
    const previousColors = useViewerStore.getState().overlayLayers;
    const token = await validateChecks(run, 'workflow', modelSet(run), [job(ruleSet())], undefined);
    const results = run.get<DocumentReportResult[]>(token, 'reports');
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, 'validation');
    if (results[0].kind === 'validation') {
      assert.equal(results[0].snapshot.summary.failed, 2, 'both real walls fail the fire rating requirement');
      assert.equal(results[0].snapshot.reportModels?.length, 2);
    }
    const saved = loadValidationReports();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].automation?.workflowId, 'workflow');
    assert.equal(saved[0].automation?.jobId, 'check');
    assert.match(saved[0].automation?.resource?.fingerprint ?? '', /^[a-f0-9]{64}$/);
    assert.equal(saved[0].automation?.models[0].sourceFingerprint, 'full-source-A');
    const doc = buildReportDocument({ results });
    assert.equal(doc.blocks.filter((block) => block.kind === 'ids-report').length, 1);
    assert.equal(useViewerStore.getState().idsValidationReport, previousLiveReport);
    assert.equal(useViewerStore.getState().overlayLayers, previousColors);
  });

  it('builds the document from a workflow template saved at the previous format version, keeping its block size (#6548)', async () => {
    run = startWorkflowRun();
    const token = await validateChecks(run, 'workflow', modelSet(run), [job(ruleSet())], undefined);
    const workflow: FlowDocument = { ...inputGraph([]), capabilities: ['storage.write:documents'] };
    const host = createAutomationHost(run, workflow, async () => { throw new Error('no model is loaded in this test'); }, () => {});
    const template = { version: DOCUMENT_VERSION - 1, id: 'template', name: 'Report', page: { size: 'A4', orientation: 'portrait' }, blocks: [{
      id: 'report', kind: 'ids-report', scale: 1.5, sourceName: 'Old', generatedAt: '2026-01-01T00:00:00.000Z', summary: { checked: 0, passed: 0, failed: 0, passRate: 100 }, checks: [],
    }] } as unknown as DocumentSpec;
    const built = await host.buildDocument(token, null, null, { template, mappings: [{ blockId: 'report', jobId: 'check' }] });
    const document = run.get<DocumentSpec>(built, 'document');
    assert.equal(document.version, DOCUMENT_VERSION);
    assert.deepEqual(document.blocks.map((block) => block.kind === 'ids-report' && block.scale), [1.5]);
  });

  it('retains comparison recipe identity and every effective option beside native evidence', async () => {
    run = startWorkflowRun();
    useViewerStore.setState({ savedComparisons: [] });
    const options = { scope: 'data', excludedTypes: ['IfcDoor'], matchByContent: true, keyProperty: 'Pset_Custom.AuthoredKey' };
    const recipe = { kind: 'ifc-lite-comparison-recipe', version: 1, id: 'recipe', name: 'Structure versus services',
      base: { kind: 'slot', slotId: 'structure' }, head: { kind: 'slot', slotId: 'services' }, options,
    };
    const token = await compareChecks(run, 'workflow', modelSet(run), [{ id: 'comparison', enabled: true, source: { kind: 'embedded', value: recipe } }], undefined);
    const results = run.get<DocumentReportResult[]>(token, 'reports');
    assert.equal(results.length, 1);
    const evidence = loadSavedComparisons().find((saved) => saved.automation?.runId === run?.id);
    assert.ok(evidence);
    assert.deepEqual(evidence.automation?.effectiveOptions, { ...options, acceptedIdentity: [] });
    assert.match(evidence.automation?.resource?.fingerprint ?? '', /^[a-f0-9]{64}$/);
    assert.equal(evidence.automation?.models[0].sourceFingerprint, 'full-source-A');
  });

  it('comparison targets constrain both recipe roles before fingerprint preparation', async () => {
    run = startWorkflowRun();
    useViewerStore.setState({ savedComparisons: [] });
    const recipe = { kind: 'ifc-lite-comparison-recipe', version: 1, id: 'recipe', name: 'A versus B',
      base: { kind: 'slot', slotId: 'structure' }, head: { kind: 'slot', slotId: 'services' },
      options: { scope: 'data', excludedTypes: [], matchByContent: false },
    };
    await assert.rejects(compareChecks(run, 'workflow', modelSet(run), [{ id: 'subset', enabled: true,
      targets: [{ kind: 'slot', slotId: 'structure' }], source: { kind: 'embedded', value: recipe },
    }], undefined), /No model matches/);
    assert.equal(useViewerStore.getState().savedComparisons.length, 0);
  });

  it('restricts evaluation to a slot subset and remaps native tag targets in a cloned rule definition', async () => {
    run = startWorkflowRun();
    useViewerStore.setState({ modelTags: new Map([['new-tag', { id: 'new-tag', name: 'Structure' }]]), modelTagAssignments: new Map([['A', new Set(['new-tag'])]]) });
    const file = ruleSet();
    file.targets = { modelTagIds: ['old-tag'] };
    file.rules[0].applicability.groups[0].rules.push(Rule.modelTag('hasAny', ['old-tag']));
    const original = structuredClone(file);
    const token = await validateChecks(run, 'workflow', modelSet(run), [job(file, {
      targets: [{ kind: 'slot', slotId: 'structure' }], tagBindings: { 'old-tag': ' structure ' },
    })], undefined);
    const results = run.get<DocumentReportResult[]>(token, 'reports');
    assert.equal(results[0].kind, 'validation');
    if (results[0].kind === 'validation') {
      assert.equal(results[0].snapshot.summary.checked, 1);
      assert.deepEqual(results[0].snapshot.reportModels?.map((m) => m.name), ['structure.ifc']);
    }
    assert.deepEqual(file, original);
    assert.deepEqual(loadValidationReports()[0].automation?.models.map((m) => m.id), ['A']);
  });

  it('retains evaluator diagnostics but blocks the reports output and document generation', async () => {
    run = startWorkflowRun();
    const file = ruleSet();
    // The native file schema accepts regex syntax; the runtime matcher rejects
    // unsafe nested quantifiers before matching any file-supplied IFC name.
    // That native evaluator diagnostic is an execution error, not a failed
    // quality requirement or an invalid JSON definition.
    file.rules[0].requirement = { kind: 'element', block: { authoredAs: 'chips', groups: [
      { combinator: 'AND', rules: [Rule.name('matches', '(a+)+$', 'regex')] },
    ] } };
    assert.equal(parseRuleSetFile(file).ok, true, 'the execution-error fixture must pass native boundary validation');
    await assert.rejects(validateChecks(run, 'workflow', modelSet(run), [job(file)], undefined), /evaluator error/);
    const evidence = loadValidationReports();
    assert.equal(evidence.length, 1);
    const snapshot = evidence[0].snapshot;
    assert.equal(snapshot.kind, 'ids-report');
    if (snapshot.kind === 'ids-report') {
      assert.match(snapshot.checks[0].error ?? '', /catastrophic/);
      assert.throws(() => buildReportDocument({ results: [{ kind: 'validation', jobId: 'check', resultId: 'error-result', snapshot }] }), /execution errors/);
    }
    assert.equal([...run.resources.values()].some((entry) => entry.kind === 'reports'), false);
  });

  it('disabled checks never execute and completed evidence survives a later failed job', async () => {
    run = startWorkflowRun();
    const file = ruleSet();
    const unknown = { ...ruleSet(), targets: { modelFingerprints: ['missing-fingerprint'] } };
    await assert.rejects(validateChecks(run, 'workflow', modelSet(run), [
      job(file, { id: 'completed' }), job(file, { id: 'disabled', enabled: false }), job(unknown, { id: 'broken' }),
    ], undefined), /no model matches/);
    assert.equal(loadValidationReports().length, 1);
    assert.equal(loadValidationReports()[0].automation?.jobId, 'completed');
  });

  it('retains each completed IDS model before cancellation of the next target', async () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS"><info><title>Wall names</title></info><specifications>
      <specification name="Walls have names" ifcVersion="IFC4"><applicability minOccurs="0" maxOccurs="unbounded">
      <entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability><requirements>
      <attribute><name><simpleValue>Name</simpleValue></name></attribute></requirements></specification></specifications></ids>`;
    const state = useViewerStore.getState();
    const model = state.models.get('A');
    assert.ok(model?.ifcDataStore);
    const completed = await runIdsCheck({ document: parseIDS(xml), modelId: 'A', dataStore: model.ifcDataStore, locale: 'en', models: state.models });
    run = startWorkflowRun();
    const activeRun = run;
    let workers = 0;
    class ControlledWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      constructor() { workers++; }
      postMessage(request: { id: number }) {
        const workerNumber = workers;
        queueMicrotask(() => {
          if (workerNumber === 1) this.onmessage?.({ data: { type: 'complete', id: request.id, report: completed.report } });
          else activeRun.cancel();
        });
      }
      terminate() {}
    }
    const previous = globalThis.Worker;
    (globalThis as { Worker?: unknown }).Worker = ControlledWorker;
    try {
      await assert.rejects(validateChecks(activeRun, 'workflow', modelSet(activeRun), [
        { id: 'ids', enabled: true, source: { kind: 'embedded', value: xml, name: 'Wall names' } },
      ], undefined), { name: 'AbortError' });
      assert.equal(workers, 2);
      const saved = loadValidationReports();
      assert.equal(saved.length, 1, 'the first model was complete before the second was cancelled');
      assert.deepEqual(saved[0].automation?.models.map((m) => m.id), ['A']);
    } finally {
      if (previous === undefined) delete (globalThis as { Worker?: unknown }).Worker;
      else globalThis.Worker = previous;
    }
  });

  it('cancellation retains the execution lease until drain and rejects foreign resource/model-set ownership', async () => {
    run = startWorkflowRun();
    const token = run.put('files', { models: [new File([IFC], 'walls.ifc')] });
    const oldSet = modelSet(run);
    assert.throws(() => run!.get(token, 'reports'), /Invalid or expired/);
    assert.throws(() => assertWorkflowOwner('foreign-owner'), /workflow is running/);
    assertWorkflowOwner(run.id);
    run.cancel();
    await assert.rejects(validateChecks(run, 'workflow', oldSet, [job(ruleSet())], undefined), { name: 'AbortError' });
    assert.equal(loadValidationReports().length, 0);
    assert.equal(isNativeWorkflowBusy(), true);
    assert.throws(() => startWorkflowRun(), /already running/);
    run.release();
    run = startWorkflowRun();
    assert.throws(() => run!.get(token, 'files'), /Invalid or expired/);
    assert.throws(() => checkedModelSet(run!, oldSet), /does not belong/);
  });

  it('surfaces unsaved tag definitions while preserving manual tags and rerun identity', () => {
    run = startWorkflowRun();
    const manual = useViewerStore.getState().createModelTag('Manual');
    assert.ok(manual);
    useViewerStore.getState().assignModelTags(['A'], [manual]);
    const storage = window.localStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
      setItem: () => { throw new Error('quota exceeded'); },
    } });
    const rules = [{ operator: 'equals', pattern: 'structure.ifc', tags: ['Structure'] }];
    try {
      assignSessionTags(run, modelSet(run), rules);
      assert.ok(run.warnings.some((warning) => warning.includes('definitions remain in memory')));
      const assigned = useViewerStore.getState().modelTagAssignments.get('A');
      assert.ok(assigned);
      assert.ok(assigned.has(manual));
      assert.equal(assigned.size, 2);
      assignSessionTags(run, modelSet(run), rules);
      assert.deepEqual(useViewerStore.getState().modelTagAssignments.get('A'), assigned);
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      else Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
    }
    assert.equal(useViewerStore.getState().retryModelTagsSave(), true);
  });

  it('pins source stores and edit revisions before native evidence can publish', () => {
    run = startWorkflowRun();
    const session = modelSet(run);
    checkedModelSet(run, session);
    useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
    assert.throws(() => checkWorkflowModelPins(run!), { name: 'AbortError' });
    run.release();
    run = startWorkflowRun();
    checkedModelSet(run, modelSet(run));
    const state = useViewerStore.getState();
    const original = state.models.get('A');
    assert.ok(original);
    useViewerStore.setState({ models: new Map(state.models).set('A', { ...original, ifcDataStore: fixtureModel('replacement').ifcDataStore }) });
    assert.throws(() => checkWorkflowModelPins(run!), { name: 'AbortError' });
    assert.equal(loadValidationReports().length, 0);
  });

  it('rejects incomplete explicitly bound models before considering them successful loads', async () => {
    run = startWorkflowRun();
    const state = useViewerStore.getState();
    const model = state.models.get('A');
    assert.ok(model);
    useViewerStore.setState({ models: new Map(state.models).set('A', { ...model, loadState: 'hydrating-metadata' }) });
    const token = run.put('files', {});
    await assert.rejects(loadSessionModels(run, 'graph', async () => assert.fail('bound models must not start a loader'), token, [
      { kind: 'filename', filename: 'structure.ifc' },
    ]), /did not finish loading/);
  });

  it('hashes the complete parsed source when explicitly binding a loaded model without a File (#6612)', async () => {
    run = startWorkflowRun();
    const model = useViewerStore.getState().models.get('A');
    assert.ok(model?.ifcDataStore);
    const source = model.ifcDataStore.source.materialize();
    const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(source));
    const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const result = await loadSessionModels(run, 'loaded-source', async () => assert.fail('bound models must not start a loader'),
      run.put('files', {}), [{ kind: 'filename', filename: 'structure.ifc' }]);
    assert.equal(result.models[0]?.sourceIdentity, expected);
    assert.equal(result.models[0]?.modelId, 'A');
  });

  it('qualifies same-named external slots and allows only unique aliases', async () => {
    run = startWorkflowRun();
    const graph = inputGraph([]);
    const document: FlowDocument = { ...graph,
      nodes: [...graph.nodes.slice(0, 1), ...['one', 'two'].map((id) => ({ id, type: 'validation.runChecks', params: {
        jobs: [job(ruleSet(), { id: `${id}-job`, source: { kind: 'slot' as const, slotId: `${id}.files/resource` } })],
      } }))],
      edges: ['one', 'two'].map((id) => ({ from: ['load', 'models'] as const, to: [id, 'models'] as const })),
      inputs: [...graph.inputs, ...['one', 'two'].map((id) => ({ nodeId: id, param: 'files', label: id, kind: 'files' as const,
        fileSlots: [{ id: 'resource', label: 'Rules', accept: '.json', multiple: false, required: true }],
      }))],
    };
    const inputs = await preflightWorkflow(run, document, {
      'load.files': { models: [new File([IFC], 'walls.ifc')] },
      'one.files': { resource: [new File([JSON.stringify(ruleSet())], 'one.rules.json')] },
      'two.files': { resource: [new File([JSON.stringify(ruleSet())], 'two.rules.json')] },
    }, features);
    assert.equal(run.files.has('resource'), false, 'ambiguous aliases must not resolve a different resource');
    assert.equal(run.files.get('one.files/resource')?.[0].name, 'one.rules.json');
    assert.equal(run.files.get('two.files/resource')?.[0].name, 'two.rules.json');
    assert.equal(run.files.get('models')?.[0].name, 'walls.ifc');
    assert.deepEqual(Object.keys(run.get(inputs['load.files'], 'files') as object), ['load.files/models']);
    const qualified: SessionModels = { runId: run.id, models: modelSet(run).models.map((m) => ({ ...m, slotId: `load.files/${m.slotId}` })) };
    assert.deepEqual(resolveModels({ kind: 'slot', slotId: 'structure' }, useViewerStore.getState(), qualified), ['A']);
    const ambiguous: SessionModels = { ...qualified, models: qualified.models.map((m) => ({ ...m, slotId: `${m.modelId}.files/models` })) };
    assert.throws(() => resolveModels({ kind: 'slot', slotId: 'models' }, useViewerStore.getState(), ambiguous), /Ambiguous/);
    assert.deepEqual(resolveModels({ kind: 'slot', slotId: 'A.files/models' }, useViewerStore.getState(), ambiguous), ['A']);
    const reversed: SessionModels = { ...qualified, models: [...qualified.models].reverse().map((m) => ({ ...m, slotId: 'load.files/models' })) };
    assert.deepEqual(resolveModels({ kind: 'slot', slotId: 'models' }, useViewerStore.getState(), reversed), ['B', 'A'], 'file selection order wins over the store insertion order');
  });

  it('preflight refuses missing grants and unresolved template mappings before loading', async () => {
    run = startWorkflowRun();
    const graph = inputGraph([job(ruleSet())]);
    const values = { 'load.files': { models: [new File([IFC], 'walls.ifc')] } };
    const before = useViewerStore.getState().models;
    await assert.rejects(preflightWorkflow(run, { ...graph, capabilities: ['model.create', 'model.read'] }, values, features), /capability denied/);
    const template = { version: 10, id: 'template', name: 'Report', page: { size: 'A4', orientation: 'portrait' }, blocks: [{
      id: 'report', kind: 'ids-report', sourceName: 'Old', generatedAt: '2026-01-01T00:00:00.000Z', summary: { checked: 0, passed: 0, failed: 0, passRate: 100 }, checks: [],
    }] };
    const withDocument: FlowDocument = { ...graph, capabilities: [...graph.capabilities, 'storage.write:documents'],
      nodes: [...graph.nodes, { id: 'document', type: 'report.buildDocument', params: { config: { template, mappings: [] } } }],
      edges: [...graph.edges, { from: ['checks', 'reports'], to: ['document', 'validation'] }],
    };
    await assert.rejects(preflightWorkflow(run, withDocument, values, features), /requires a result mapping/);
    assert.equal(useViewerStore.getState().models, before);
  });

  it('preflights file slots and definitions before any live-model mutation', async () => {
    run = startWorkflowRun();
    const modelsBefore = useViewerStore.getState().models;
    const tagsBefore = useViewerStore.getState().modelTagAssignments;
    await assert.rejects(preflightWorkflow(run, inputGraph([job(ruleSet())]), {
      'load.files': { models: [new File(['bad'], 'invalid.json')] },
    }, features), /Unsupported file/);
    const invalid = job({ ...ruleSet(), version: 999 } as unknown as RuleSetFile);
    await assert.rejects(preflightWorkflow(run, inputGraph([invalid]), {
      'load.files': { models: [new File([IFC], 'walls.ifc')] },
    }, features), /version/);
    assert.equal(useViewerStore.getState().models, modelsBefore);
    assert.equal(useViewerStore.getState().modelTagAssignments, tagsBefore);
    assert.equal(loadValidationReports().length, 0);
  });

  it('reuses full source bytes across runs with placement-hash identities and retains overlays (#6612)', async () => {
    const graphId = crypto.randomUUID();
    const file = new File([IFC], 'repeat.ifc');
    const hash = await computeFullSourceHashFromBlob(file);
    assert.match(hash ?? '', /^[a-f0-9]{64}$/);
    const store = useViewerStore.getState().models.get('A')!.ifcDataStore!;
    let loads = 0;
    const loader = async (selected: File, options?: { modelId?: string }) => {
      loads++;
      assert.ok(options?.modelId);
      const model = { ...fixtureModel(options.modelId), ifcDataStore: store,
        sourceFile: selected, name: selected.name, sourceContentHash: 'placement-sha256-1m-v1:abcdef' };
      useViewerStore.setState({ models: new Map(useViewerStore.getState().models).set(model.id, model) });
      return model.id;
    };
    run = startWorkflowRun();
    const first = await loadSessionModels(run, graphId, loader, run.put('files', { models: [file] }), []);
    assert.equal(first.models[0].sourceIdentity, hash);
    const modelId = first.models[0].modelId;
    run.release();
    const overlay = new MutablePropertyView(store.properties, modelId);
    overlay.setProperty(100, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.Label);
    useViewerStore.setState({ mutationViews: new Map([[modelId, overlay]]) });
    run = startWorkflowRun();
    const second = await loadSessionModels(run, graphId, loader,
      run.put('files', { models: [new File([IFC], 'repeat.ifc')] }), []);
    assert.equal(loads, 1, 'same full bytes reuse the bound model despite prefixed placement identity');
    assert.equal(second.models[0].modelId, modelId);
    assert.equal(useViewerStore.getState().getMutationView(modelId), overlay);
    assert.equal(overlay.getPropertyValue(100, 'Pset_WallCommon', 'FireRating'), 'F90');
    await validateChecks(run, graphId, second, [job(ruleSet())], undefined);
    assert.equal(loadValidationReports()[0].automation?.models[0].sourceFingerprint, hash,
      'native report provenance uses full source bytes rather than placement cache identity');
    run.release();
    const replacement = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer, { disableWorkerScan: true });
    const state = useViewerStore.getState();
    useViewerStore.setState({ models: new Map(state.models).set(modelId, { ...state.models.get(modelId)!, ifcDataStore: replacement }) });
    run = startWorkflowRun();
    const third = await loadSessionModels(run, graphId, loader, run.put('files', { models: [file] }), []);
    assert.equal(loads, 2, 'a same-ID store replacement cannot impersonate the private binding');
    assert.notEqual(third.models[0].modelId, modelId);
  });

});
