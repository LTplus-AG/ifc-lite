/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { refuseContentWrites } from '@/test/content-fixture';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { deferred } from '@/test/race';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import type { ToolHost } from '../types';
import { clashSettings } from './clash-native';
import { executeOperation } from './executor';
import { viewerOperation } from './registry';
import { runRequestOf } from '@/lib/clash/run-request';
let host: ToolHost;
const call = (id: string, input: unknown = {}, write = false, canEdit: () => boolean = () => true) =>
  dispatchMainViewerTool(
    host,
    write ? 'viewer_operation_execute' : 'viewer_operation_inspect',
    { operation_id: id, input },
    { canEdit },
  );
function value<T>(result: AgentToolResult): T {
  assert.equal(result.isError, false, result.text);
  const output = (result.structured as { result: { native_json: string } }).result;
  return JSON.parse(output.native_json) as T;
}
const runInput = (kind: 'all' | 'duplicates' = 'all') => ({
  kind,
  preset_id: '',
  expected_model_ids: [...useViewerStore.getState().models.keys()],
  expected_settings: JSON.stringify(clashSettings()),
});
describe('native Clash operation parity (#10525 follow-up)', () => {
  beforeEach(async () => {
    await seedCoincidentWalls(2);
    const s = useViewerStore.getState();
    s.clearClashExclusions();
    s.setClashMode('hard');
    s.setClashTolerance(0.002);
    s.setClashReportTouch(false);
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  });
  for (const count of [1, 2] as const)
    it(`runs real ${count}-model meshes with native identities and preserves another feature’s isolation`, async () => {
      await seedCoincidentWalls(count);
      const isolated = new Set([1]);
      useViewerStore.setState({ isolatedEntities: isolated, clashVisibilityOwned: null });
      const result = value<{ run_seq: number; count: number }>(await call('clash.run', runInput(), true));
      assert.ok(result.count > 0);
      assert.equal(useViewerStore.getState().isolatedEntities, isolated);
      const pairs = value<{ clashes: Array<{ clash: { a: { model: string }; b: { model: string } } }> }>(
        await call('clash.results', { offset: 0, limit: 10, run_seq: result.run_seq }),
      );
      assert.equal(pairs.clashes.length, 1, 'two coincident walls make exactly one pair');
      const { a, b } = pairs.clashes[0].clash;
      assert.deepEqual([a.model, b.model].sort(), count === 1 ? ['A', 'A'] : ['A', 'B']);
      value(await call('clash.run', runInput('duplicates'), true));
      assert.equal(runRequestOf(useViewerStore.getState().clashRawResult)?.kind, 'duplicates');
    });
  it('refuses a continuation after native clash review changes a page row (#10877)', async () => {
    await seedCoincidentWalls(1, 3);
    const { run_seq } = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const first = value<{ next_offset: number; page_revision: string; clashes: { clash: { id: string } }[] }>(
      await call('clash.results', { offset: 0, limit: 1, run_seq }));
    assert.equal(first.next_offset, 1); assert.ok(first.page_revision);
    const next = { offset: first.next_offset, page_revision: first.page_revision, limit: 1, run_seq };
    value(await call('clash.results', next));
    value(await call('clash.review', { clash_id: first.clashes[0].clash.id, run_seq, status: 'accepted', comment: 'Reviewed between pages' }, true));
    assert.equal((await call('clash.results', next)).errorCode, 'STATE_CHANGED');
  });
  it('refuses stale settings and revoked write grants before native publication', async () => {
    const input = runInput();
    useViewerStore.getState().setClashTolerance(0.1);
    assert.equal((await call('clash.run', input, true)).isError, true);
    const seq = useViewerStore.getState().clashRunSeq;
    let grant = true;
    const pending = call('clash.run', runInput(), true, () => grant);
    grant = false;
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(useViewerStore.getState().clashRunSeq, seq);
  });
  it('preserves native unavailable refusals for unresolved clash pairs and groups (#10871)', async () => {
    await seedCoincidentWalls(1, 3);
    const { run_seq } = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const { clashResult, resolveGlobalIdInModel } = useViewerStore.getState();
    assert.ok(clashResult);
    // Keep the same loaded model and run, with findings whose entity refs no longer resolve.
    const missing = Number.MAX_SAFE_INTEGER;
    const clashes = clashResult.clashes.map(clash => {
      assert.equal(resolveGlobalIdInModel(clash.a.model, missing), null);
      return { ...clash, a: { ...clash.a, ref: missing }, b: { ...clash.b, ref: missing } };
    });
    useViewerStore.setState({ clashResult: { ...clashResult, clashes } });
    const ids = clashes.map(clash => clash.id);
    assert.ok(ids.length > 1);
    for (const [element, clash_ids] of [['pair', [ids[0]]], ['pair', ids], ['a', [ids[0]]], ['b', [ids[0]]]] as const) {
      useViewerStore.getState().setClashError(null);
      const result = await call('clash.focus', { clash_ids, run_seq, element, mode: 'highlight' }, true);
      assert.equal(result.errorCode, 'UNSUPPORTED_OPERATION', result.text);
      assert.equal((result.structured as { reason: string }).reason, 'unavailable');
      assert.equal(useViewerStore.getState().clashErrorKind, 'unavailable');
      if (element !== 'pair') continue;
      useViewerStore.getState().setClashError(null);
      const topic = await call('clash.topic.create', {
        kind: clash_ids.length === 1 ? 'pair' : 'group', clash_ids, run_seq, group_name: 'Group', mode: 'highlight',
      }, true);
      assert.equal(topic.errorCode, 'UNSUPPORTED_OPERATION', topic.text);
      assert.equal((topic.structured as { reason: string }).reason, 'unavailable');
    }
  });

  it('distinguishes conflicting evidence from storage failure when importing a valid clash report (#10871)', async () => {
    const { run_seq } = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const { id } = value<{ id: string }>(await call('clash.reports.save', { name: 'Coordination', run_seq }, true));
    const report = useViewerStore.getState().savedClashReports.find(row => row.id === id)!;
    const { expected_reports } = value<{ expected_reports: string }>(await call('clash.reports.read'));
    const importReport = (report_json: string) => call('clash.reports.write', {
      action: 'import', id: '', name: '', report_json, expected_reports,
    }, true);
    const refused = refuseContentWrites();
    try {
      const result = await importReport(JSON.stringify({ ...report, id: 'imported-report' }));
      assert.equal(result.errorCode, 'INTERNAL_ERROR', result.text);
      assert.equal((result.structured as { reason: string }).reason, 'internal');
    } finally { refused.mock.restore(); }

    const latest = value<{ expected_reports: string }>(await call('clash.reports.read'));
    const result = await call('clash.reports.write', {
      action: 'import', id: '', name: '', expected_reports: latest.expected_reports,
      report_json: JSON.stringify({ ...report, savedAt: '2020-01-01T00:00:00.000Z' }),
    }, true);
    assert.equal(result.errorCode, 'INVALID_INPUT', result.text);
    assert.equal((result.structured as { reason: string }).reason, 'conflict');
  });

  it('filters and restores native findings without rerunning and writes durable native reviews', async () => {
    const result = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const s = useViewerStore.getState(),
      pair = s.clashResult!.clashes[0],
      count = s.clashResult!.clashes.length;
    value(
      await call(
        'clash.review',
        { clash_id: pair.id, run_seq: result.run_seq, status: 'accepted', comment: 'Designed overlap' },
        true,
      ),
    );
    value(
      await call(
        'clash.exclusions.write',
        {
          action: 'typePair',
          clash_id: pair.id,
          run_seq: result.run_seq,
          tag: '',
          id: '',
          enabled: true,
          expected_exclusions: JSON.stringify(s.clashExclusions),
        },
        true,
      ),
    );
    assert.equal(useViewerStore.getState().clashResult!.clashes.length, 0);
    assert.equal(useViewerStore.getState().clashRunSeq, result.run_seq);
    value(
      await call(
        'clash.exclusions.write',
        {
          action: 'clear',
          clash_id: '',
          run_seq: result.run_seq,
          tag: '',
          id: '',
          enabled: false,
          expected_exclusions: JSON.stringify(useViewerStore.getState().clashExclusions),
        },
        true,
      ),
    );
    assert.equal(useViewerStore.getState().clashResult!.clashes.length, count);
    const page = value<{ clashes: Array<{ review: { status: string; comment: string } }> }>(
      await call('clash.results', { offset: 0, limit: 10, run_seq: result.run_seq }),
    );
    assert.equal(page.clashes[0].review.status, 'accepted');
    assert.equal(page.clashes[0].review.comment, 'Designed overlap');
  });
  it('exports actual native CSV/BCF artifacts and refuses topic publication without a viewport', async () => {
    const result = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const csv = value<{ bytes: number; mime_type: string }>(
      await call('clash.export', { kind: 'csv', run_seq: result.run_seq }, true),
    );
    assert.ok(csv.bytes > 100);
    assert.equal(csv.mime_type, 'text/csv');
    const bcf = value<{ artifact: { bytes: number } }>(
      await call(
        'clash.exportBcf',
        {
          run_seq: result.run_seq,
          groupBy: 'rule',
          severities: ['major', 'critical', 'minor', 'info'],
          includeSnapshots: false,
          maxTopics: 20,
          clash_ids: [],
        },
        true,
      ),
    );
    assert.ok(bcf.artifact.bytes > 100);
    // #10871: a severity filter can select zero findings from a real nonempty run.
    const severity = useViewerStore.getState().clashResult!.clashes[0].severity;
    const empty = await call('clash.exportBcf', {
      run_seq: result.run_seq, groupBy: 'rule', severities: [severity === 'info' ? 'critical' : 'info'],
      includeSnapshots: false, maxTopics: 20, clash_ids: [],
    }, true);
    assert.equal(empty.errorCode, 'INVALID_INPUT', empty.text);
    assert.equal((empty.structured as { reason: string }).reason, 'invalid-value');
    useViewerStore.setState({ bcfProject: null });
    const topic = await call(
      'clash.topic.create',
      { kind: 'report', clash_ids: [], run_seq: result.run_seq, group_name: '', mode: 'highlight' },
      true,
    );
    assert.equal(topic.isError, true);
    assert.equal(useViewerStore.getState().bcfProject, null);
  });
  it('clash.drafts.create drafts the reviewed active workspace and refuses a token read before a workspace switch (#10794)', async (t) => {
    const run = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const id = useViewerStore.getState().clashResult!.clashes[0].id;
    const [row] = value<Array<{ member: unknown }>>(await call('clash.groups.evidence', { run_seq: run.run_seq, clash_ids: [id] }));
    const workspace = { version: 1, id: 'reviewed', name: 'Reviewed', groups: [{ id: 'g', name: 'Walls', members: [row.member] }] };
    const written = value<{ expected_library: string }>(await call('clash.groups.write', { workspace_json: JSON.stringify(workspace), expected_library: value<{ expected_library: string }>(await call('clash.groups.read')).expected_library }, true));
    // #10871: the library is ready, but this caller-specified workspace does not exist.
    const missing = await call('clash.groups.library', { action: 'select', workspace_id: 'missing', expected_library: written.expected_library }, true);
    assert.equal(missing.errorCode, 'INVALID_INPUT', missing.text);
    assert.equal((missing.structured as { reason: string }).reason, 'unknown-target');
    const selected = value<{ active_id: string; expected_library: string }>(await call('clash.groups.library', { action: 'select', workspace_id: 'reviewed', expected_library: written.expected_library }, true));
    assert.equal(selected.active_id, 'reviewed');
    const { expected_library } = value<{ expected_library: string }>(await call('clash.groups.read'));
    assert.equal(expected_library, selected.expected_library, 'select hands back the token the next write needs');
    const draft = { source: 'groups', clash_ids: [], run_seq: run.run_seq, name: 'Groups', title: 'Groups' };
    // Another client switches the active workspace between this read and the draft.
    const { useClashGroupLibrary, DEFAULT_GROUP_WORKSPACE } = await import('@/lib/clash/group-workspace');
    t.after(() => useClashGroupLibrary.setState({ entries: useClashGroupLibrary.getState().entries.filter(entry => entry.id !== 'reviewed'), activeId: DEFAULT_GROUP_WORKSPACE }));
    useClashGroupLibrary.setState({ activeId: DEFAULT_GROUP_WORKSPACE });
    const stale = await call('clash.drafts.create', { ...draft, expected_groups: expected_library }, true);
    assert.equal(stale.isError, true); assert.match(stale.text, /Manual groups changed/);
    useClashGroupLibrary.setState({ activeId: 'reviewed' });
    const created = await call('clash.drafts.create', { ...draft, expected_groups: expected_library }, true);
    assert.equal(created.isError, false, created.text);
    const result = (created.structured as { result: { batch_id: string; topics: number } }).result;
    assert.ok(result.batch_id); assert.equal(result.topics, 1, 'one topic for the one reviewed group');
  });
  it('classifies malformed preset JSON and accepts an exported preset payload (#10871)', async () => {
    const preset = useViewerStore.getState().clashPresets[0];
    const input = { action: 'import', id: '', enabled: false, expected_presets: JSON.stringify(useViewerStore.getState().clashPresets) };
    const invalid = await call('clash.presets.write', { ...input, preset_json: '{' }, true);
    assert.equal(invalid.errorCode, 'INVALID_INPUT', invalid.text);
    assert.equal((invalid.structured as { reason: string }).reason, 'invalid-value');
    value(await call('clash.presets.write', { ...input, preset_json: JSON.stringify({ presets: [preset] }) }, true));
    assert.ok(useViewerStore.getState().clashPresets.some(row => !row.builtin && row.name === preset.name));
  });
  it('a clash run refusal carries the code of its condition (#10871)', async () => {
    // A deleted rule is the caller's input; a matrix with every rule disabled is a state the viewer must leave first.
    const gone = await call('clash.run', { ...runInput(), kind: 'preset', preset_id: 'deleted-rule' }, true);
    assert.equal(gone.isError, true); assert.equal(gone.errorCode, 'INVALID_INPUT', gone.text); assert.equal((gone.structured as { reason?: string }).reason, 'unknown-target');
    const presets = useViewerStore.getState().clashPresets;
    const reasonOf = (result: AgentToolResult) => (result.structured as { reason?: string }).reason;
    try {
      useViewerStore.setState({ clashPresets: presets.map(preset => ({ ...preset, enabled: false })) });
      const off = await call('clash.run', { ...runInput(), kind: 'matrix' }, true);
      assert.equal(off.isError, true); assert.equal(off.errorCode, 'UNSUPPORTED_OPERATION', off.text); assert.equal(reasonOf(off), 'unavailable');
      // A rule whose set filter names a model tag that no longer exists is refused: fixing the rule makes it run.
      const filtered = { ...presets[0], enabled: true, filterA: [{ combinator: 'AND', rules: [{ kind: 'modelTag', op: 'in', tagIds: ['no-such-tag'] }] }] };
      useViewerStore.setState({ clashPresets: [filtered, ...presets.slice(1)] as never });
      const refused = await call('clash.run', { ...runInput(), kind: 'preset', preset_id: filtered.id }, true);
      assert.equal(refused.errorCode, 'INVALID_INPUT', refused.text); assert.equal(reasonOf(refused), 'refused');
      // A rerun of a rule deleted since is not the caller's input: it named no rule.
      useViewerStore.setState({ clashPresets: presets });
      value(await call('clash.run', { ...runInput(), kind: 'preset', preset_id: presets[0].id }, true));
      useViewerStore.setState({ clashPresets: presets.slice(1) });
      const rerun = await call('clash.run', { ...runInput(), kind: 'rerun', preset_id: '' }, true);
      assert.equal(rerun.errorCode, 'UNSUPPORTED_OPERATION', rerun.text); assert.equal(reasonOf(rerun), 'unavailable');
    } finally { useViewerStore.setState({ clashPresets: presets }); }
  });
  it('rejects overlapping occurrence claims through the real native manual-group codec', async () => {
    const result = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const id = useViewerStore.getState().clashResult!.clashes[0].id;
    const rows = value<Array<{ member: unknown }>>(
      await call('clash.groups.evidence', { run_seq: result.run_seq, clash_ids: [id] }),
    );
    const write = async (groups: unknown[]) => {
      const { expected_library } = value<{ expected_library: string }>(await call('clash.groups.read'));
      const workspace = { version: 1, id: 'conflicting-workspace', name: 'Conflicting', groups };
      return call('clash.groups.write', { workspace_json: JSON.stringify(workspace), expected_library }, true);
    };
    // The same workspace with one claim persists, so only the second claim can cause the refusal.
    value(await write([{ id: 'a', name: 'A', members: [rows[0].member] }]));
    const before = value<{ expected_library: string }>(await call('clash.groups.read')).expected_library;
    const refused = await write([
      { id: 'a', name: 'A', members: [rows[0].member] },
      { id: 'b', name: 'B', members: [rows[0].member] },
    ]);
    assert.equal(refused.isError, true);
    assert.equal(value<{ expected_library: string }>(await call('clash.groups.read')).expected_library, before);
  });
  it('#11029: classification evicts the oldest review only when the replacement is delivered', async () => {
    value(await call('clash.run', runInput(), true));
    const prepare = () => call('clash.classification.prepare', {}, true);
    const { token } = value<{ token: string }>(await prepare());
    for (let i = 1; i < 32; i++) value(await prepare());
    const answer = JSON.stringify({
      version: 1, kind: 'clash.groups',
      groups: [{ name: 'Collision', explanation: 'Coincident walls', citations: ['E1'] }],
    });
    const sample = (reviewToken: string) => call('clash.classification.sample', { token: reviewToken, answer }, true);
    const held: { claim?: import('../delivery').DeliveryClaim } = {};
    const stage = () => dispatchMainViewerTool(host, 'viewer_operation_execute', {
      operation_id: 'clash.classification.prepare', input: {}, idempotency_key: 'replacement-classification',
    }, { canEdit: () => true, onDelivery: claim => { held.claim = claim; } });
    // The real handler has completed and returned a token. The transport still holds its delivery claim.
    const dropped = value<{ token: string }>(await stage()).token;
    assert.ok(held.claim);
    value(await sample(token));
    assert.match((await sample(dropped)).text, /Unknown native classification review/);
    held.claim.drop();
    value(await sample(token));
    assert.match((await sample(dropped)).text, /Unknown native classification review/);
    // Every drop must release its provisional slot, even while the published review cache stays full.
    for (let i = 0; i < 32; i++) {
      assert.notEqual(value<{ token: string }>(await stage()).token, dropped);
      held.claim.drop();
    }
    const next = value<{ token: string }>(await stage()).token;
    value(await sample(token));
    held.claim.deliver();
    assert.match((await sample(token)).text, /Unknown native classification review/);
    value(await sample(next));
  });

  it('#11029: a keyed classification sample survives its initiating caller cancelling', async t => {
    value(await call('clash.run', runInput(), true));
    const { token } = value<{ token: string }>(await call('clash.classification.prepare', {}, true));
    const request = {
      operation_id: 'clash.classification.sample', idempotency_key: 'sample',
      input: { token, answer: JSON.stringify({ version: 1, kind: 'clash.groups',
        groups: [{ name: 'Collision', explanation: 'Coincident walls', citations: ['E1'] }] }) },
    };
    const entry = viewerOperation(request.operation_id);
    const execute = entry.execute.bind(entry);
    const entered = deferred(), resume = deferred();
    const native = t.mock.method(entry, 'execute', async (...args: Parameters<typeof execute>) => {
      entered.resolve();
      await resume.promise;
      return execute(...args);
    });
    t.after(() => resume.resolve());
    const controller = new AbortController();
    const first = dispatchMainViewerTool(host, 'viewer_operation_execute', request, {
      signal: controller.signal, canEdit: () => true,
    });
    await Promise.race([entered.promise, first.then(result => {
      throw new Error(`Sample ended before its native gate: ${result.text}`);
    })]);
    const survivor = executeOperation(host, undefined, request, { canEdit: () => true }, false);
    controller.abort();
    const [cancelled, shared] = await Promise.all([first.then(result => {
      resume.resolve();
      return result;
    }), survivor]);
    assert.equal(cancelled.errorCode, 'CANCELLED');
    assert.equal(native.mock.callCount(), 1);
    assert.deepEqual(await executeOperation(host, undefined, request, { canEdit: () => true }, false), shared);
    value(await call('clash.classification.plan', { token, workspace_id: '', name: 'Reviewed collision' }, true));
  });

  it('grounds typed grouping evidence, applies a native reviewed partition, and undoes only its own revision', async () => {
    value(await call('clash.run', runInput(), true));
    const libraryBefore = value<{ expected_library: string }>(await call('clash.groups.read')).expected_library;
    const prepared = value<{ token: string }>(await call('clash.classification.prepare', {}, true));
    const answer = JSON.stringify({
      version: 1,
      kind: 'clash.groups',
      groups: [{ name: 'Reviewed collision', explanation: 'One native coincident wall pair', citations: ['E1'] }],
    });
    value(await call('clash.classification.sample', { token: prepared.token, answer }, true));
    const planned = value<{ after: { id: string } }>(
      await call(
        'clash.classification.plan',
        { token: prepared.token, workspace_id: '', name: 'Reviewed fixture grouping' },
        true,
      ),
    );
    const applied = value<{ receipt: { id: string; status: string } }>(
      await call('clash.classification.apply', { token: prepared.token, confirm_moves: false }, true),
    );
    assert.equal(applied.receipt.status, 'applied');
    const { useClashGroupLibrary } = await import('@/lib/clash/group-workspace');
    assert.ok(
      useClashGroupLibrary
        .getState()
        .entries.some((entry) => entry.id === planned.after.id && entry.groups.length === 1),
    );
    const undone = value<{ receipt: { status: string } }>(
      await call('clash.classification.undo', { receipt_id: applied.receipt.id }, true),
    );
    assert.equal(undone.receipt.status, 'undone');
    assert.equal(value<{ expected_library: string }>(await call('clash.groups.read')).expected_library, libraryBefore);
    assert.equal((await call('clash.classification.undo', { receipt_id: applied.receipt.id }, true)).isError, true);
  });
  it('refuses an exact rerun when no run was recorded', async () => {
    value(await call('clash.run', runInput(), true));
    useViewerStore.getState().clearClash();
    const seq = useViewerStore.getState().clashRunSeq;
    const refused = await call('clash.run', { ...runInput(), kind: 'rerun' }, true);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /No recorded clash run/);
    assert.equal(useViewerStore.getState().clashRunSeq, seq, 'no Detect all was started');
  });
  const firstPair = async () => {
    const result = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    return { run_seq: result.run_seq, pair: useViewerStore.getState().clashResult!.clashes[0] };
  };
  it('refuses a review comment that a reload would cut', async () => {
    const { run_seq, pair } = await firstPair();
    const review = (comment: string) => call('clash.review', { clash_id: pair.id, run_seq, status: 'accepted', comment }, true);
    assert.equal((await review('x'.repeat(2001))).isError, true);
    value(await review(` ${'x'.repeat(2000)} `));
  });
  it('refuses a preset import with no valid rules, as the panel does', async () => {
    const presets = (preset_json: string) =>
      call('clash.presets.write', { action: 'import', id: '', preset_json, enabled: true, expected_presets: JSON.stringify(useViewerStore.getState().clashPresets) }, true);
    for (const file of ['{}', '[]', '{"presets":[{"bogus":1}]}']) {
      const refused = await presets(file);
      assert.equal(refused.isError, true, file);
      assert.match(refused.text, /no valid clash rules/);
    }
  });
  it('refuses a preset import over the rule cap as a limit while the library has room (#10871)', async () => {
    const { exportPresets, defaultPresets } = await import('@/lib/clash/persistence');
    const base = defaultPresets()[0], presets = useViewerStore.getState().clashPresets;
    const rules = (prefix: string, length: number) => Array.from({ length }, (_, n) => ({ ...base, id: `${prefix}-${n}`, name: `${prefix} ${n}`, builtin: false }));
    const importFile = (file: typeof presets) => {
      let preset_json = '';
      exportPresets(file, (content) => { preset_json = content; });
      return call('clash.presets.write', { action: 'import', id: '', preset_json, enabled: true, expected_presets: JSON.stringify(useViewerStore.getState().clashPresets) }, true);
    };
    try {
      const alone = await importFile(rules('bulk', 201));
      assert.equal(alone.errorCode, 'INVALID_INPUT', alone.text); assert.equal((alone.structured as { reason?: string } | null)?.reason, 'limit');
      // 150 held plus 100 passes the cap, but a 50-rule file would fit.
      useViewerStore.setState({ clashPresets: [...presets, ...rules('held', 150)] });
      const more = await importFile(rules('more', 100));
      assert.equal(more.errorCode, 'INVALID_INPUT', more.text); assert.equal((more.structured as { reason?: string; save?: string } | null)?.reason, 'limit');
      assert.equal((more.structured as { save?: string } | null)?.save, 'too_many');
      // One rule into a library already at the cap: no smaller file helps.
      useViewerStore.setState({ clashPresets: [...presets, ...rules('held', 200)] });
      const full = await importFile(rules('one', 1));
      assert.equal(full.errorCode, 'UNSUPPORTED_OPERATION', full.text);
    } finally { useViewerStore.setState({ clashPresets: presets }); }
  });
  it('trims the IFC class of a type exclusion', async () => {
    const { run_seq } = await firstPair();
    value(
      await call('clash.exclusions.write', {
        action: 'typeAny', clash_id: '', run_seq, tag: ' IfcWall ', id: '', enabled: true,
        expected_exclusions: JSON.stringify(useViewerStore.getState().clashExclusions),
      }, true),
    );
    assert.equal(useViewerStore.getState().clashResult!.clashes.length, 0, 'the trimmed class suppresses the wall pair');
  });
});
