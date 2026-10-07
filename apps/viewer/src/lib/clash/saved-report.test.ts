/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The saved clash report's rules that the mounted tests cannot reach one at a
 * time (#6947): how the loaded models are compared with the recorded ones, and
 * what capture keeps of a run.
 *
 * The module is loaded inside the tests: it does not exist without this
 * feature, and an absent module must read as a failed assertion here, not as a
 * test file that never ran.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClashEngine, type ClashElement } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';

async function load() {
  const module = await import('./saved-report.js').catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(module, 'saved clash reports exist (#6947)');
  return module;
}

function box(key: string, ref: number, tag: string): ClashElement {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  return { key, ref, model: 'm1', tag, bounds: { min: [0, 0, 0], max: [1, 1, 1] }, positions, indices };
}

describe('Saved clash report: loaded model revision (#6947)', () => {
  // `mutationRevision`: the edit counter the run recorded, or 'none' for a run that recorded none.
  const recorded = (models: Array<{ id: string; name: string; sourceFingerprint?: string; sourceContentHash?: string }>, mutationRevision: number | 'none' = 0) =>
    ({ models, run: { settings: { tolerance: 0.002, excludeVoidsAndHosts: true }, rules: [], ...(mutationRevision === 'none' ? {} : { mutationRevision }) } });

  it('is the same revision only when every recorded model is loaded with the same source identity and nothing was edited', async () => {
    const { clashReportRevision } = await load();
    const report = recorded([{ id: 'a', name: 'arch.ifc', sourceFingerprint: 'fp-a' }, { id: 's', name: 'struct.ifc', sourceFingerprint: 'fp-s' }]);
    const arch = { name: 'arch.ifc', sourceFingerprint: 'fp-a' }, struct = { name: 'struct.ifc', sourceFingerprint: 'fp-s' };
    assert.equal(clashReportRevision(report, [arch, struct], 0), 'same');
    assert.equal(clashReportRevision(report, [struct, arch, { name: 'mep.ifc', sourceFingerprint: 'fp-m' }], 0), 'same', 'an extra loaded model does not change what was recorded');
    assert.equal(clashReportRevision(report, [{ ...arch, name: 'renamed.ifc' }, struct], 0), 'same', 'identity is the content, not the display name');
    assert.equal(clashReportRevision(report, [arch], 0), 'not-loaded', 'one recorded model missing');
    assert.equal(clashReportRevision(report, [arch, { name: 'struct.ifc', sourceFingerprint: 'fp-s2' }], 0), 'different', 'the same file name with other content is another revision');
    assert.equal(clashReportRevision(report, [], 0), 'not-loaded');
  });

  it('never calls an edited or unidentified model the same revision', async () => {
    const { clashReportRevision } = await load();
    const arch = { name: 'arch.ifc', sourceFingerprint: 'fp-a' };
    const report = recorded([{ id: 'a', name: 'arch.ifc', sourceFingerprint: 'fp-a' }]);
    assert.equal(clashReportRevision(report, [arch], 3), 'unverified', 'the loaded model carries edits made in the viewer');
    assert.equal(clashReportRevision(recorded(report.models, 2), [arch], 0), 'unverified', 'the run itself was made on an edited model');
    assert.equal(clashReportRevision(recorded(report.models, 'none'), [arch], 0), 'unverified', 'a run that recorded no edit counter cannot vouch for itself');
    assert.equal(clashReportRevision(recorded([{ id: 'a', name: 'arch.ifc' }]), [{ name: 'arch.ifc' }], 0), 'unverified', 'a name alone is not an identity');
    assert.equal(clashReportRevision(recorded([{ id: 'a', name: 'arch.ifc' }]), [{ name: 'other.ifc' }], 0), 'not-loaded');
    assert.equal(clashReportRevision(recorded([]), [arch], 0), 'unverified', 'a report that recorded no model');
  });

  it('lets the full-content hash overrule the sampled fingerprint when both sides have one', async () => {
    const { clashReportRevision } = await load();
    const report = recorded([{ id: 'a', name: 'arch.ifc', sourceFingerprint: 'fp-a', sourceContentHash: 'hash-1' }]);
    assert.equal(clashReportRevision(report, [{ name: 'arch.ifc', sourceFingerprint: 'fp-a', sourceContentHash: 'hash-2' }], 0), 'different',
      'an edit between the fingerprint samples changes the hash, not the fingerprint');
    assert.equal(clashReportRevision(report, [{ name: 'arch.ifc', sourceFingerprint: 'fp-other', sourceContentHash: 'hash-1' }], 0), 'same');
    assert.equal(clashReportRevision(report, [{ name: 'arch.ifc', sourceFingerprint: 'fp-a' }], 0), 'same', 'with the hash unknown on one side the fingerprint decides');
  });

  it('does not call a model another revision when the two sides share no kind of identity to compare', async () => {
    const { clashReportRevision } = await load();
    const hashOnly = recorded([{ id: 'a', name: 'arch.ifc', sourceContentHash: 'hash-1' }]);
    const fingerprintOnly = recorded([{ id: 'a', name: 'arch.ifc', sourceFingerprint: 'fp-a' }]);
    // Nothing was compared in these three: a hash against a fingerprint, either way round, and an identity against none.
    assert.equal(clashReportRevision(hashOnly, [{ name: 'arch.ifc', sourceFingerprint: 'fp-a' }], 0), 'unverified');
    assert.equal(clashReportRevision(fingerprintOnly, [{ name: 'arch.ifc', sourceContentHash: 'hash-1' }], 0), 'unverified');
    assert.equal(clashReportRevision(fingerprintOnly, [{ name: 'arch.ifc' }], 0), 'unverified');
    // Control: one comparable same-named model that differs is still another revision, whatever else is loaded.
    assert.equal(clashReportRevision(hashOnly, [{ name: 'arch.ifc', sourceFingerprint: 'fp-a' }, { name: 'arch.ifc', sourceContentHash: 'hash-2' }], 0), 'different');
    assert.equal(clashReportRevision(hashOnly, [{ name: 'arch.ifc', sourceContentHash: 'hash-2' }], 0), 'different');
  });
});

describe('Saved clash report: what capture keeps of a run (#6947)', () => {
  it('keeps the rules with their coverage and how each side was chosen, the review comment, and no renderer ids', async () => {
    const { snapshotClashReport, isSavedClashReport } = await load();
    const { clashMemberKey, clashReviewKey } = await import('@ifc-lite/clash');
    const elements = [box('0WallGuid0000000000001', 11, 'IfcWall'), box('0BeamGuid0000000000002', 12, 'IfcBeam'), box('0DuctGuid0000000000003', 13, 'IfcDuctSegment')];
    const result = await createClashEngine({ backend: 'ts' }).run(elements, [
      { id: 'str', name: 'Walls vs beams', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' },
      { id: 'picked', name: 'Picked ducts', a: '', membersA: [clashMemberKey('m1', 13)], b: 'IfcWall', mode: 'hard', severity: 'minor' },
    ]);
    assert.equal(result.clashes.length, 2);
    const [first] = result.clashes;
    const state = { ...useViewerStore.getState(), models: new Map(), clashResult: result, clashRawResult: result, clashGroups: null, clashGroupsKind: null,
      clashSuppressedCount: 4, clashReviews: new Map([[clashReviewKey(first), { status: 'accepted' as const, comment: 'By design' }]]) };
    const report = snapshotClashReport(state, '  Coordination week 41  ', new Date('2026-10-07T09:30:00.000Z'));
    assert.ok(report && isSavedClashReport(report));
    assert.equal(report.name, 'Coordination week 41');
    assert.equal(report.savedAt, '2026-10-07T09:30:00.000Z');
    assert.deepEqual(report.run.rules, [
      { id: 'str', name: 'Walls vs beams', a: 'IfcWall', b: 'IfcBeam', mode: 'hard', matchedA: 1, matchedB: 1 },
      { id: 'picked', name: 'Picked ducts', a: '', b: 'IfcWall', mode: 'hard', severity: 'minor', fromMembersA: true, matchedA: 1, matchedB: 1 },
    ], 'a side chosen by an explicit member list is flagged and counted; the list itself, ids of one load, is not kept');
    assert.equal(report.completeness.excluded, 4);
    const saved = report.clashes.find((clash) => clash.id === first.id);
    assert.deepEqual([saved?.review, saved?.comment], ['accepted', 'By design']);
    assert.deepEqual(report.clashes.find((clash) => clash.id !== first.id)?.review, 'open');
    assert.doesNotMatch(JSON.stringify(report), /"ref":/, 'no renderer id is stored');
    assert.deepEqual(report.models, [{ id: 'm1', name: 'm1' }], 'a model that is no longer loaded is named by the id the run saw, with no invented identity');
    assert.equal(snapshotClashReport({ ...state, clashResult: null }, 'nothing'), null);
  });

  it('names an unnamed report after its rules and the time it was saved', async () => {
    const { defaultClashReportName } = await load();
    const now = new Date('2026-10-07T09:30:00.000Z');
    const rules = (...names: string[]) => ({ rulesRun: names.map((name, index) => ({ id: `r${index}`, name, a: 'IfcWall', mode: 'hard' as const })) });
    assert.equal(defaultClashReportName(rules('MEP vs STR'), now), 'MEP vs STR 2026-10-07 09:30');
    assert.equal(defaultClashReportName(rules('A', 'B', 'C'), now), 'A +2 2026-10-07 09:30');
    assert.equal(defaultClashReportName(rules(), now), 'Clash run 2026-10-07 09:30');
  });
});
