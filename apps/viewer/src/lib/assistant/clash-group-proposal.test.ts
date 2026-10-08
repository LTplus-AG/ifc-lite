/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { captureEvidence } from './evidence';
import { normalizeClashGroupAnswer, parseClashGroupPatch, prepareClashGroupPreview, resolveCapturedClash } from './clash-group-proposal';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
function findings(count = 120): Clash[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `finding-${i}`, rule: 'coordination', status: 'hard', severity: 'major', distance: -0.02,
    a: { key: `A${i}`, ref: 1 + i, model: 'architecture', tag: 'IfcWall' },
    b: { key: `B${i}`, ref: 1_000_001 + i, model: 'services', tag: 'IfcPipeSegment' },
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  }));
}
function install(clashes = findings()) {
  const result = { clashes, summary: summarizeClashes(clashes), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ ...fixtureModels(fixtureModel('architecture'), fixtureModel('services', { idOffset: 1_000_000 })),
    clashResult: result, clashRawResult: result });
  return captureEvidence('clash');
}
const answer = (citations: string[], extra = {}) => JSON.stringify({ version: 1, kind: 'clash.groups',
  groups: [{ name: 'Wall / pipe coordination', explanation: 'Ambiguous architecture/structure and MEP/fire selectors', citations, ...extra }] });

// #6847: the partition covers the actual population, never only the LLM sample.
test('inert preview partitions full native population and preserves native severity and ambiguity', () => {
  const snapshot = install();
  const native = useViewerStore.getState();
  const preview = prepareClashGroupPreview(answer(['E1', 'E2']), snapshot);
  assert.equal(preview.totalFindings, 120);
  assert.equal(preview.proposedFindings, 2);
  assert.equal(preview.unclassifiedFindings, 118);
  assert.equal(preview.omittedFromEvidence, 120 - snapshot.includedRows);
  assert.deepEqual(preview.groups[0].findings[0].disciplineCandidates, { a: ['ARCH', 'STR'], b: ['MEP', 'FIRE'] });
  assert.equal(preview.groups[0].findings[0].nativeSeverity, 'major');
  assert.equal(preview.groups[0].findings[0].nativeType, 'hard');
  assert.equal(useViewerStore.getState(), native, 'preparation performs no native effects');
});

test('strict parser refuses duplicate membership, native writes, unknown fields and partial text', () => {
  for (const invalid of [answer(['E1', 'E1']), answer(['E101']), answer(['E1'], { severity: 'info' }),
    answer(['E1'], { assignedTo: 'invented@example.test' }), answer(['E1'], { status: 'accepted' }),
    answer(['E1']) + ' run this', answer(['E1']).slice(0, -1), 'x'.repeat(48_001)]) {
    assert.throws(() => parseClashGroupPatch(invalid));
  }
  assert.equal(parseClashGroupPatch('```json\n' + answer(['E1']) + '\n```').groups.length, 1);
  const repeated = JSON.parse(answer(['E1']));
  repeated.groups.push({ name: 'Other', explanation: 'Second claim', citations: ['E1'] });
  assert.throws(() => parseClashGroupPatch(JSON.stringify(repeated)));
});

test('unknown, ambiguous and projected references refuse; equal GUIDs across model pairs stay distinct', () => {
  const clashes = findings(2);
  clashes[1].a.key = clashes[0].a.key;
  clashes[1].b.key = clashes[0].b.key;
  clashes[1].b.model = 'another-services';
  const snapshot = install(clashes);
  const preview = prepareClashGroupPreview(answer(['E1', 'E2']), snapshot);
  assert.notEqual(preview.groups[0].findings[0].occurrence, preview.groups[0].findings[1].occurrence);
  assert.throws(() => prepareClashGroupPreview(answer(['E3']), snapshot), /Unknown/);
  clashes[1].b.model = clashes[0].b.model;
  assert.throws(() => prepareClashGroupPreview(answer(['E1']), snapshot), /ambiguous/);
  const projected = install([{ ...findings(1)[0], a: { ...findings(1)[0].a, name: 'x'.repeat(2000) } }]);
  assert.throws(() => prepareClashGroupPreview(answer(['E1']), projected), /incomplete/);
});

test('native result replacement, geometry edits and changed native facts refuse preview', () => {
  const snapshot = install(findings(1));
  useViewerStore.getState().clashResult!.clashes[0].severity = 'minor';
  assert.throws(() => prepareClashGroupPreview(answer(['E1']), snapshot), /facts changed/);
  const fresh = install(findings(1));
  useViewerStore.setState({ geometryContentVersion: initial.geometryContentVersion + 1 });
  assert.throws(() => prepareClashGroupPreview(answer(['E1']), fresh), /stale/);
  const replaced = install(findings(1));
  useViewerStore.setState({ clashResult: { ...useViewerStore.getState().clashResult! } });
  assert.throws(() => prepareClashGroupPreview(answer(['E1']), replaced), /stale/);
});

// Free models (qwen3-coder-next, 2026-10-04) repeated citations across groups and cited E76 of 75 rows.
test('a refused proposal normalizes only by disclosed first-group-wins and unknown removal', () => {
  const snapshot = install();
  const raw = JSON.stringify({ version: 1, kind: 'clash.groups', groups: [
    { name: 'Roof', explanation: 'Rafters', citations: ['E1', 'E2', 'E2', 'E999'] },
    { name: 'Walls', explanation: 'Slabs', citations: ['E2', 'E3'] },
    { name: 'Roof', explanation: 'Duplicate name', citations: ['E4'] },
    { name: 'Ghost', explanation: 'Only invented rows', citations: ['E101'] }] });
  assert.throws(() => parseClashGroupPatch(raw), /unique captured evidence citations/);
  const normalized = normalizeClashGroupAnswer(raw, snapshot)!;
  assert.deepEqual({ repeats: normalized.removedRepeats, unknown: normalized.removedUnknown, dropped: normalized.droppedGroups },
    { repeats: 2, unknown: 2, dropped: 2 });
  const preview = prepareClashGroupPreview(normalized.answer, snapshot);
  assert.deepEqual(preview.groups.map(group => [group.name, group.citations]), [['Roof', ['E1', 'E2']], ['Walls', ['E3']]]);
  assert.equal(preview.proposedFindings + preview.unclassifiedFindings, preview.totalFindings, 'every finding still accounted once');
  assert.equal(normalizeClashGroupAnswer(JSON.stringify({ version: 1, kind: 'clash.groups', groups: [{ name: 'X', explanation: 'Y', citations: ['E999'] }] }), snapshot), null);
});

test('a citation resolves to its live native finding only while evidence is current', () => {
  const snapshot = install();
  assert.equal(resolveCapturedClash(snapshot, 'E3')?.id, 'finding-2');
  assert.equal(resolveCapturedClash(snapshot, 'E999'), null);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(resolveCapturedClash(snapshot, 'E3'), null);
});
