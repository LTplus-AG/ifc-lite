/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A refusal of the caller's input reaches the agent as INVALID_INPUT with a details.reason, in the foreground and from
 * a background job, and a stale precondition as STATE_CHANGED (#10871). Before, every operation refusal was a plain
 * Error that reached the agent as INTERNAL_ERROR, and a failed job kept only its message.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { DEFAULT_APPEARANCE_SETTINGS } from '@/lib/appearance/settings';
import { blankDocument } from '@/lib/document/presets';
import { modelOverviewDashboard } from '@/lib/charts/presets';
import { DEFAULT_ANONYMIZE_TOGGLES } from '@/components/viewer/anonymized-export/AnonymizationOptionsPanel';
import { parseHelloWall, model, seed, viewerHost } from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import { viewerOperation } from './registry';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial); resetFeaturesForTest(); });
const anon = { target_model_id: 'missing', seed_ids: [1], excluded_ids: [], excluded_types: [], file_stem: 'anonymous', anonymize: { ...DEFAULT_ANONYMIZE_TOGGLES },
  relations: { IfcRelVoidsElement: false, IfcRelFillsElement: false, IfcRelAggregates: 'none', IfcRelNests: 'none', IfcRelDefinesByType: false, IfcRelAssociatesMaterial: false, IfcRelContainedInSpatialStructure: false, IfcRelDefinesByProperties: false, IfcRelConnectsPathElementsDepth: 0 } };
const reason = (result: AgentToolResult) => (result.structured as { reason?: string } | null)?.reason;

describe('operation refusals carry an executor code and a reason (#10871)', () => {
  it('an unknown target is INVALID_INPUT with reason unknown-target, not INTERNAL_ERROR', async () => {
    seed([model('A', await parseHelloWall())]); const host = viewerHost();
    const result = await dispatchMainViewerTool(host, 'viewer_operation_inspect', { operation_id: 'exports.anonymized.prepare', input: anon });
    assert.equal(result.isError, true); assert.equal(result.errorCode, 'INVALID_INPUT', result.text); assert.equal(reason(result), 'unknown-target');
  });

  it('excluding a seed is wrong-target, not unknown-target: the id exists but cannot be excluded', async () => {
    const store = await parseHelloWall(); seed([model('A', store)]); const host = viewerHost();
    const wall = [...store.entityIndex.byId.keys()].find(id => store.entities.getTypeName(id) === 'IfcWall');
    assert.ok(wall !== undefined, 'the fixture has a wall');
    const result = await dispatchMainViewerTool(host, 'viewer_operation_inspect', { operation_id: 'exports.anonymized.prepare', input: { ...anon, target_model_id: 'A', seed_ids: [wall], excluded_ids: [wall] } });
    assert.equal(result.errorCode, 'INVALID_INPUT', result.text); assert.equal(reason(result), 'wrong-target');
  });

  it('a stale expected-state token is STATE_CHANGED with reason stale', async () => {
    const host = viewerHost();
    const result = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'zones.set.create', input: { name: 'Z', expected_configuration: '1:0' } }, { canEdit: () => true });
    assert.equal(result.isError, true); assert.equal(result.errorCode, 'STATE_CHANGED', result.text); assert.equal(reason(result), 'stale');
  });

  it('the native chart evaluator reports an unknown chart as an input refusal', async () => {
    const dashboard = modelOverviewDashboard();
    useViewerStore.setState({ dashboards: [dashboard] });
    const result = await dispatchMainViewerTool(viewerHost(), 'viewer_operation_inspect', {
      operation_id: 'charts.evaluate', input: { dashboard_id: dashboard.id, chart_id: 'missing' },
    });
    assert.equal(result.errorCode, 'INVALID_INPUT', result.text);
    assert.equal(reason(result), 'unknown-target');
  });

  it('a report export for an unknown dashboard reports an invalid target', async () => {
    const dashboard = modelOverviewDashboard();
    useViewerStore.setState({ dashboards: [dashboard] });
    const result = await dispatchMainViewerTool(viewerHost(), 'viewer_operation_execute', {
      operation_id: 'charts.exportReport', input: {
        id: 'missing', expected_json: JSON.stringify(dashboard), page: { size: 'A4', orientation: 'portrait' },
        title_block: { project: '', title: '', author: '', date: '', revision: '' }, snapshots: false, save_setup: false,
      },
    }, { canEdit: () => true });
    assert.equal(result.errorCode, 'INVALID_INPUT', result.text);
    assert.equal(reason(result), 'unknown-target');
  });

  it('reference preparation distinguishes an unknown target, stale source and unavailable renderer', async () => {
    const host = viewerHost();
    const source = { id: 'image', assetId: 'fixture', name: 'Fixture.png', width: 1, height: 1 };
    useViewerStore.getState().addAppearanceSource(source);
    const prepare = (source_id: string, expected_source = JSON.stringify(source), edit_reference_id = '') =>
      dispatchMainViewerTool(host, 'viewer_operation_execute', {
        operation_id: 'appearance.references.prepare', input: {
          source_id, expected_source, edit_reference_id, settings_json: JSON.stringify(DEFAULT_APPEARANCE_SETTINGS),
        },
      }, { canEdit: () => true, signal: new AbortController().signal });
    for (const [result, code, expected] of [
      [await prepare('missing'), 'INVALID_INPUT', 'unknown-target'],
      [await prepare(source.id, JSON.stringify(source), 'missing'), 'INVALID_INPUT', 'unknown-target'],
      [await prepare(source.id, '{}'), 'STATE_CHANGED', 'stale'],
      [await prepare(source.id), 'UNSUPPORTED_OPERATION', 'unavailable'],
    ] as const) {
      assert.equal(result.errorCode, code, result.text);
      assert.equal(reason(result), expected);
    }
  });

  it('deleting a document while its revision is calculated reports stale state', async t => {
    const document = blankDocument();
    useViewerStore.setState({ documents: [document] });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    t.mock.method(crypto.subtle, 'digest', (...args: Parameters<SubtleCrypto['digest']>) => {
      useViewerStore.setState({ documents: [] });
      return digest(...args);
    });
    const result = await dispatchMainViewerTool(viewerHost(), 'viewer_operation_inspect', {
      operation_id: 'document.inspect', input: { id: document.id, offset: 0, limit: 1 },
    });
    assert.equal(result.errorCode, 'STATE_CHANGED', result.text);
    assert.equal(reason(result), 'stale');
  });

  it('malformed JSON in a string field is INVALID_INPUT, not a SyntaxError reported as INTERNAL_ERROR', async () => {
    seed([model('A', await parseHelloWall())]); const host = viewerHost();
    const result = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'validation.rules.export', input: { rules_json: '{not json', format: 'json' } }, { canEdit: () => true });
    assert.equal(result.isError, true); assert.equal(result.errorCode, 'INVALID_INPUT', result.text); assert.equal(reason(result), 'invalid-value');
    assert.match(result.text, /rules_json is not valid JSON\./); assert.doesNotMatch(result.text, /not json/, 'the input is not quoted back');
    // A lib decoder's own throw, for bad JSON or a failed schema, refuses the input too.
    for (const content_json of ['{not json', '{"kind":"not-a-dashboard"}']) {
      const decoded = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'charts.import', input: { content_json } }, { canEdit: () => true });
      assert.equal(decoded.errorCode, 'INVALID_INPUT', decoded.text); assert.equal(reason(decoded), 'invalid-value');
    }
    // A decoder that parses the raw field itself names the field and never quotes the input back.
    const quoted = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'charts.import', input: { content_json: '{"secret": tok' } }, { canEdit: () => true });
    assert.match(quoted.text, /content_json is not valid JSON\./); assert.doesNotMatch(quoted.text, /secret/);
    const proposal = await dispatchMainViewerTool(host, 'viewer_operation_inspect', { operation_id: 'properties.prepare', input: { proposal_json: '{not json' } });
    assert.equal(proposal.errorCode, 'INVALID_INPUT', proposal.text); assert.equal(reason(proposal), 'invalid-value');
    assert.match(proposal.text, /proposal_json is not valid JSON\./); assert.doesNotMatch(proposal.text, /not json/);
  });

  it('a failed lens save is refused inside the commit, so it is never reported as a committed write', async (t: TestContext) => {
    const host = viewerHost();
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: { getItem: () => null, setItem: () => { throw new Error('blocked'); }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } });
    t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete (globalThis as { localStorage?: unknown }).localStorage; });
    useViewerStore.setState({ savedLenses: [...useViewerStore.getState().savedLenses, { id: 'custom', name: 'Custom', rules: [] } as never] });
    for (const call of [{ operation_id: 'lens.import', input: { content_json: '[]' } }, { operation_id: 'lens.delete', input: { id: 'custom' } }]) {
      const result = await dispatchMainViewerTool(host, 'viewer_operation_execute', call, { canEdit: () => true });
      assert.equal(result.isError, true, call.operation_id); assert.equal(result.errorCode, 'UNSUPPORTED_OPERATION', result.text);
      const details = result.structured as { reason?: string; committed?: boolean; save?: string };
      assert.equal(details.reason, 'unavailable'); assert.equal(details.save, 'unavailable'); assert.equal(details.committed, undefined, call.operation_id);
      assert.ok(useViewerStore.getState().savedLenses.some(lens => lens.id === 'custom'), `${call.operation_id} left the lens in place`);
    }
    const notArray = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'lens.import', input: { content_json: '{"id":"x"}' } }, { canEdit: () => true });
    assert.equal(notArray.errorCode, 'INVALID_INPUT'); assert.equal(reason(notArray), 'invalid-value');
  });

  it('a save failure maps by its reason, and a decoder keeps its own diagnostic but not a viewer fault', async () => {
    const { saveRefusal, decodedInput } = await import('./refusals') as { saveRefusal?: (f: { reason: string; message: string }) => { code: string; details?: { save?: string } }; decodedInput?: <T>(field: string, decode: () => T, options?: { json?: boolean }) => T };
    assert.ok(saveRefusal && decodedInput, 'helpers exist');
    for (const save of ['unavailable', 'unreadable', 'too_many']) assert.equal(saveRefusal({ reason: save, message: 'm' }).code, 'UNSUPPORTED_OPERATION', save);
    for (const save of ['quota', 'serialize', 'rollback_failed']) assert.equal(saveRefusal({ reason: save, message: 'm' }).code, 'INTERNAL_ERROR', save);
    assert.equal(saveRefusal({ reason: 'quota', message: 'm' }).details?.save, 'quota');
    const parseError = Object.assign(new Error('Invalid XML format'), { details: 'line 3: unclosed tag' + 'x'.repeat(1000) });
    assert.throws(() => decodedInput('xml', () => { throw parseError; }), (error: { code?: string; message?: string }) =>
      error.code === 'INVALID_INPUT' && /^xml: Invalid XML format \(line 3: unclosed tag/.test(error.message ?? '') && (error.message ?? '').length < 600);
    const astral = Object.assign(new Error('Bad'), { details: `${'a'.repeat(499)}😀${'b'.repeat(10)}` });
    assert.throws(() => decodedInput('xml', () => { throw astral; }), (error: { message?: string }) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(error.message ?? ''));
    // Non-JSON decoders keep their capped syntax diagnostic. JSON decoders use the same message across engines.
    assert.throws(() => decodedInput('xml', () => { throw new SyntaxError(`Invalid regular expression: /JSON(/: ${'x'.repeat(1000)}`); }), (error: { message?: string }) =>
      /^xml: Invalid regular expression/.test(error.message ?? '') && (error.message ?? '').length < 600);
    for (const message of ['Unexpected token', 'JSON.parse: expected property name', 'JSON Parse error: Unexpected identifier "secret"']) {
      assert.throws(() => decodedInput('content_json', () => { throw new SyntaxError(message); }, { json: true }),
        (error: { message?: string }) => error.message === 'content_json is not valid JSON.');
    }
    const fault = new TypeError('crypto.randomUUID is not a function');
    assert.throws(() => decodedInput('content_json', () => { throw fault; }, { json: true }), (error: unknown) => error === fault);
  });

  it('a result that fails its own output schema is INTERNAL_ERROR, not the caller\'s input', async (t: TestContext) => {
    const host = viewerHost();
    t.mock.method(viewerOperation('zones.read'), 'execute', async () => ({ native_json: 5 }));
    const result = await dispatchMainViewerTool(host, 'viewer_operation_inspect', { operation_id: 'zones.read', input: {} });
    assert.equal(result.isError, true); assert.equal(result.errorCode, 'INTERNAL_ERROR', result.text); assert.equal(reason(result), 'internal');
  });

  it('a mutation-gate denial is UNSUPPORTED_OPERATION when waiting helps and PERMISSION_DENIED when it is forbidden', async () => {
    // Reached dynamically, so with the fix reverted this file still loads and the assertions fail.
    const { mutationRefusal } = await import('./mutation-refusal') as { mutationRefusal?: (denial: string, modelId?: string | undefined) => { code: string; details?: { reason?: string; denial?: string } } };
    assert.ok(mutationRefusal, 'mutationRefusal exists');
    for (const denial of ['workflow-running', 'properties-loading']) assert.equal(mutationRefusal(denial).code, 'UNSUPPORTED_OPERATION', denial);
    for (const denial of ['switched-off', 'edit-mode', 'collab-role']) assert.equal(mutationRefusal(denial).code, 'PERMISSION_DENIED', denial);
    assert.equal(mutationRefusal('properties-failed').code, 'INTERNAL_ERROR');
    assert.equal(mutationRefusal('id-space-exhausted', 'A').details?.reason, 'wrong-target', 'waiting never restores id capacity');
    // model-unavailable depends on the model: gone, still loading, failed, loaded without editable IFC data, or none named.
    seed([model('A', await parseHelloWall()), model('loading', null, { loadState: 'streaming-geometry' }), model('failed', null, { loadState: 'error' }), model('mesh', null)]);
    assert.equal(mutationRefusal('model-unavailable', 'gone').details?.reason, 'unknown-target');
    assert.equal(mutationRefusal('model-unavailable', 'loading').code, 'UNSUPPORTED_OPERATION');
    assert.equal(mutationRefusal('model-unavailable', 'failed').code, 'INTERNAL_ERROR');
    assert.equal(mutationRefusal('model-unavailable', 'mesh').details?.reason, 'wrong-target');
    assert.equal(mutationRefusal('model-unavailable', undefined).details?.reason, 'wrong-target');
    assert.equal(mutationRefusal('edit-mode').details?.denial, 'edit-mode');
  });

  it('a background job keeps the failed operation\'s code and details', async () => {
    seed([model('A', await parseHelloWall())]); const host = viewerHost();
    const started = await dispatchMainViewerTool(host, 'viewer_operation_inspect', { operation_id: 'exports.anonymized.prepare', input: anon, background: true });
    assert.equal(started.isError, false, started.text);
    const { job } = started.structured as { job: { id: string } };
    let snapshot: { state: string; error?: string; error_code?: string; error_details?: { reason?: string } } = { state: 'running' };
    for (let i = 0; i < 100 && snapshot.state === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      snapshot = (await dispatchMainViewerTool(host, 'viewer_operation_job', { job_id: job.id })).structured as typeof snapshot;
    }
    assert.equal(snapshot.state, 'failed'); assert.equal(snapshot.error_code, 'INVALID_INPUT', snapshot.error ?? ''); assert.equal(snapshot.error_details?.reason, 'unknown-target');
  });
});
