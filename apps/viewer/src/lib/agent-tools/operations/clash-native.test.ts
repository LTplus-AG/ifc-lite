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
  it('clash.drafts.create accepts the expected_library revision that clash.groups.read returns as expected_groups (#10794)', async () => {
    const run = value<{ run_seq: number }>(await call('clash.run', runInput(), true));
    const { expected_library } = value<{ expected_library: string }>(await call('clash.groups.read'));
    const draft = { source: 'groups', clash_ids: [], run_seq: run.run_seq, name: 'Groups', title: 'Groups' };
    assert.doesNotMatch((await call('clash.drafts.create', { ...draft, expected_groups: expected_library }, true)).text, /Manual groups changed/);
    assert.match((await call('clash.drafts.create', { ...draft, expected_groups: '1:0' }, true)).text, /Manual groups changed/);
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
