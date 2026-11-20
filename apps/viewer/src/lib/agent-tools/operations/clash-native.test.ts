/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import type { ToolHost } from '../types';
import { clashSettings } from './clash-native';
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
  it('releases clash-owned isolation when highlighting all findings (#10795 item 8)', async () => {
    await seedCoincidentWalls(1);
    value(await call('clash.run', runInput(), true));
    const ids = new Set([1]);
    useViewerStore.setState({ isolatedEntities: ids, clashVisibilityOwned: { channel: 'isolate', ids } });
    value(await call('clash.action', { action: 'highlightAll' }, true));
    assert.equal(useViewerStore.getState().isolatedEntities, null);
    assert.equal(useViewerStore.getState().clashVisibilityOwned, null);
    assert.equal(useViewerStore.getState().selectedEntityIds.size, 2);
  });
  it('selects the resolved side before framing it (#10795 item 11)', async (t) => {
    await seedCoincidentWalls(1);
    const { run_seq } = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const [pair] = useViewerStore.getState().clashResult!.clashes;
    const ref = useViewerStore.getState().resolveGlobalIdInModel(pair.a.model, pair.a.ref);
    assert.ok(ref);
    const frame = t.mock.fn(() => {
      const state = useViewerStore.getState();
      assert.equal(state.selectedEntityId, pair.a.ref);
      assert.deepEqual(state.selectedEntityIds, new Set([pair.a.ref]));
      assert.deepEqual(state.selectedEntity, ref);
    });
    const callbacks = useViewerStore.getState().cameraCallbacks;
    let scheduled: FrameRequestCallback | undefined;
    t.mock.method(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduled = callback;
      return 1;
    });
    useViewerStore.setState({ cameraCallbacks: { ...callbacks, frameSelection: frame } });
    t.after(() => useViewerStore.setState({ cameraCallbacks: callbacks }));

    const result = value<{ dispatched: boolean }>(await call('clash.focus', {
      clash_ids: [pair.id], run_seq, mode: 'highlight', element: 'a',
    }, true));
    assert.equal(result.dispatched, true);
    assert.ok(scheduled);
    scheduled(0);
    assert.equal(frame.mock.callCount(), 1);
  });
  it('reports a single-side focus refusal for a missing element (#10795 item 11)', async () => {
    const { run_seq } = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const current = useViewerStore.getState().clashResult!;
    const [pair] = current.clashes;
    useViewerStore.setState({ clashResult: { ...current, clashes: [{ ...pair, a: { ...pair.a, ref: 987654 } }] } });
    const result = await call('clash.focus', { clash_ids: [pair.id], run_seq, mode: 'highlight', element: 'a' }, true);
    assert.equal(result.isError, true);
    assert.match(result.text, /reference elements that are no longer in the model/);
  });
  it('guards view settings against a concurrent change to the review filter (#10795 item 14)', async () => {
    const filter = new Set(['open'] as const);
    useViewerStore.setState({ clashStatusFilter: filter });
    const inspect = async () => value<{ expected_view_settings: string }>(await call('clash.state')).expected_view_settings;
    const input = { sortBy: 'severity', hideTouching: true, focusMode: 'highlight', showRegionBox: false,
      statusFilter: ['open'], expected_view_settings: await inspect() };
    assert.equal(typeof input.expected_view_settings, 'string');
    value(await call('clash.viewSettings', input, true));
    const expected_view_settings = await inspect();
    useViewerStore.getState().toggleClashStatusFilter('accepted');
    const stale = await call('clash.viewSettings', { ...input, expected_view_settings }, true);
    assert.equal(stale.isError, true);
    assert.match(stale.text, /Clash settings changed/);
    assert.ok(useViewerStore.getState().clashStatusFilter.has('accepted'));
  });
  it('canonicalizes known type-any tags and refuses unknown classes (#10795 item 17)', async () => {
    const { run_seq } = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const input = { action: 'typeAny', clash_id: '', run_seq, id: '', enabled: true, expected_exclusions: '[]' };
    const unknown = await call('clash.exclusions.write', { ...input, tag: 'IfcUnknownClass' }, true);
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /known IFC class/);
    value(await call('clash.exclusions.write', { ...input, tag: ' IFCWALL ' }, true));
    assert.equal(useViewerStore.getState().clashResult?.clashes.length, 0);
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
