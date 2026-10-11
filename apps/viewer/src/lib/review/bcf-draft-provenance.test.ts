/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7373: reviewed BCF drafts keep the exact non-clash source findings and the
// native runs that owned them through durable save, reload and .bcfzip
// roundtrip. Everything enters through the real Review and native draft
// owners: the committed revision pair, the native clash/IDS/compare engines,
// the native saved-validation library, the durable draft library and the
// BCF writer/reader.

import '@/test/setup-dom.js';
import '@/test/content-fixture';
import { act } from 'react';
import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readBCF, writeBCF } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import { revisionPair, runClash, runIds } from '@/lib/compare/revision-pair.test-support';
import { validationReportSnapshot } from '@/lib/validation/reports/history';
import { waitForValidationReportsCommit } from '@/test/content-fixture';
import { bcfDraftLibrary, saveDraftBatch, useBcfDraftLibrary, adoptImportedBatches } from '../bcf-drafts/draft-library';
import { exportDraftArchive, importDraftArchive } from '../bcf-drafts/draft-archive';
import { findingFromClash } from '../bcf-drafts/draft-create';
import { mergeDraftTopics, splitDraftTopic } from '../bcf-drafts/draft-edit';
import { findingIdentity, type DraftBatch, type DraftFinding, type DraftSourceFinding, type DraftTopic } from '../bcf-drafts/draft-types';
import { captureReviewSnapshot } from './collect';
import { draftTopicsFromCards } from './actions';
import type { CoordinationCard } from './cards';
import type { ReviewFinding } from './types';

const initial = useViewerStore.getState();
afterEach(() => { act(() => { useViewerStore.setState(initial, true); useBcfDraftLibrary.setState({ activeId: null }); }); });

/**
 * Real Review state: a clash run over both revisions, a live IDS run on B with
 * the same report saved through the native library (historical evidence), and
 * the live A->B comparison. One clash then leaves the live run, as a newer run
 * where it was resolved would.
 */
async function reviewed(t: TestContext, resolveOne = true) {
  const pair = await revisionPair(t); if (!pair) return null;
  const clashes = await runClash(pair, ['A', 'B']);
  assert.ok(clashes.clashes.length > 1, 'the revision pair has several native clashes');
  const ids = await runIds(pair, 'B');
  act(() => useViewerStore.setState({ models: new Map([['A', pair.base], ['B', pair.head]]), clashResult: clashes, clashRawResult: clashes,
    idsValidationReport: ids, compareResult: pair.compare, compareReconciliation: null, compareRunCaptures: [], savedComparisons: [] }));
  await useViewerStore.getState().initializeValidationReports();
  assert.ok(await useViewerStore.getState().saveValidationReport(validationReportSnapshot(ids, useViewerStore.getState().models, 'native-run')));
  await waitForValidationReportsCommit();
  const snapshot = captureReviewSnapshot();
  const resolved = clashes.clashes[0];
  if (resolveOne) act(() => useViewerStore.setState({ clashResult: { ...clashes, clashes: clashes.clashes.slice(1) } }));
  const cards = snapshot.cards.filter(card => card.state === 'current' && card.topics.length === 0);
  return { pair, clashes, resolved, cards };
}

const nonMembers = (card: CoordinationCard, live: ReadonlySet<string>) => card.findings.filter(finding =>
  !(finding.evidence.kind === 'clash' && finding.run.temporal === 'current' && finding.lifecycle !== 'record' && live.has(finding.evidence.clashId)));

function expectedMembership(finding: ReviewFinding): string {
  if (finding.lifecycle === 'record') return 'record';
  if (finding.run.temporal !== 'current') return 'historical';
  return finding.evidence.kind === 'clash' ? 'not-in-live-run' : 'included';
}

test('#7373 reviewed drafts keep exact non-clash source findings and their runs through durable save, reload and archive', async t => {
  const source = await reviewed(t); if (!source) return;
  const live = new Set(source.clashes.clashes.slice(1).map(clash => clash.id));
  const sources = new Set(source.cards.flatMap(card => card.findings.map(finding => finding.evidence.kind)));
  for (const kind of ['clash', 'validation', 'saved-validation', 'comparison']) assert.ok(sources.has(kind as never), `real ${kind} findings reach Review`);

  const drafted = await draftTopicsFromCards('Coordination round', source.cards);
  assert.equal(drafted.saved, true, 'the native durable draft library committed the batch');
  const batch = drafted.batch!;
  assert.equal(batch.topics.length, source.cards.length);

  let included = 0, members = 0;
  for (const [index, card] of source.cards.entries()) {
    const topic = batch.topics[index];
    const expected = nonMembers(card, live);
    assert.deepEqual(topic.sourceFindings?.map(finding => finding.id), expected.map(finding => finding.id), 'every non-member finding, by its exact review id');
    for (const [at, finding] of expected.entries()) {
      const frozen: DraftSourceFinding = topic.sourceFindings![at];
      assert.equal(frozen.membership, expectedMembership(finding));
      assert.deepEqual(frozen.evidence, finding.evidence, 'the exact native row');
      assert.equal(frozen.lineage, finding.lineage);
      assert.equal(frozen.nativeStatus, finding.nativeStatus);
      assert.deepEqual(frozen.run, { id: finding.run.id, source: finding.run.source, temporal: finding.run.temporal, label: finding.run.label,
        capturedAt: finding.run.capturedAt, complete: finding.run.complete, gaps: finding.run.incomplete.map(gap => gap.code), models: finding.run.models });
    }
    // Clash members are exactly the live clashes, never invented for other evidence.
    const liveMembers: DraftFinding[] = card.findings.flatMap(finding => {
      const { evidence } = finding;
      if (evidence.kind !== 'clash' || finding.run.temporal !== 'current' || !live.has(evidence.clashId)) return [];
      return [findingFromClash(source.clashes.clashes.find(clash => clash.id === evidence.clashId)!)];
    });
    assert.deepEqual(topic.members, liveMembers);
    if (liveMembers.length === 0) {
      const validated = card.elements.flatMap(element => element.key ? [{ ifcGuid: element.globalId }] : []);
      assert.deepEqual(topic.viewpoint?.components?.selection ?? [], validated, 'validated elements stay selected in the viewpoint');
    }
    members += topic.members.length;
    included += expected.filter(finding => expectedMembership(finding) === 'included').length;
  }
  const all = batch.topics.flatMap(topic => topic.sourceFindings ?? []);
  for (const membership of ['included', 'historical', 'not-in-live-run']) assert.ok(all.some(finding => finding.membership === membership), membership);
  assert.ok(all.some(finding => finding.evidence.kind === 'clash' && finding.evidence.clashId === source.resolved.id && finding.membership === 'not-in-live-run'),
    'the clash that left the live run is named, never a member');
  assert.ok(all.filter(finding => finding.membership === 'historical').every(finding => finding.run.temporal === 'historical'),
    'saved evidence is never claimed current');
  assert.equal(batch.source.findingCount, members + included, 'counts include non-clash findings without inventing clash occurrences');

  // Reload from the durable store.
  act(() => useBcfDraftLibrary.setState({ entries: [] }));
  await bcfDraftLibrary.restore();
  const reloaded = useBcfDraftLibrary.getState().entries.find(entry => entry.id === batch.id);
  assert.deepEqual(reloaded, batch, 'native durable save and reload keep provenance exactly');

  // Real .bcfzip bytes: export, read back, and adopt.
  const bytes = await (await exportDraftArchive(reloaded!, 'coordinator@example.test')).arrayBuffer();
  const imported = await importDraftArchive(bytes);
  assert.equal(imported.damaged, 0);
  const [restored] = imported.batches;
  assert.deepEqual(restored.topics.map(topic => topic.sourceFindings), batch.topics.map(topic => topic.sourceFindings));
  assert.deepEqual(restored.topics.map(topic => topic.members), batch.topics.map(topic => topic.members));
  assert.deepEqual(restored.source, batch.source);
  // Adoption saves the import through the same durable library (as a copy: the BCF reader adds default visibility).
  const [adopted] = await adoptImportedBatches(imported.batches);
  act(() => useBcfDraftLibrary.setState({ entries: [] }));
  await bcfDraftLibrary.restore();
  const kept = useBcfDraftLibrary.getState().entries.find(entry => entry.id === adopted.id);
  assert.deepEqual(kept?.topics.map(topic => topic.sourceFindings), batch.topics.map(topic => topic.sourceFindings));
});

test('#7373 an edited source line in an archive is reported damaged and never trusted', async t => {
  const source = await reviewed(t); if (!source) return;
  const { batch } = await draftTopicsFromCards('Round', source.cards);
  const project = await readBCF(await (await exportDraftArchive(batch!, 'a@example.test')).arrayBuffer());
  const target = batch!.topics.find(topic => topic.sourceFindings?.some(finding => finding.membership === 'historical'));
  assert.ok(target);
  const exported = project.topics.get(target.guid)!;
  const before = exported.description!;
  // Promote saved evidence to current by hand: the digest no longer matches.
  exported.description = before.replace(/\ns: ([^\n]+)/g, (line, value: string) => {
    const decoded = decodeURIComponent(value);
    return decoded.includes('"membership":"historical"')
      ? `\ns: ${encodeURIComponent(decoded.replace('"membership":"historical"', '"membership":"included"').replace('"temporal":"historical"', '"temporal":"current"'))}` : line;
  });
  assert.notEqual(exported.description, before);
  const imported = await importDraftArchive(await (await writeBCF(project)).arrayBuffer());
  assert.equal(imported.damaged, 1);
  const unmapped = imported.batches.flatMap(entry => entry.topics).find(topic => topic.guid === target.guid);
  assert.ok(unmapped);
  assert.equal(unmapped.origin.kind, 'archive');
  assert.equal(unmapped.sourceFindings, undefined, 'no half-trusted provenance');
});

test('#7373 an ownership conflict or a historical finding claimed current is refused and the last approved draft stays', async t => {
  const source = await reviewed(t); if (!source) return;
  const { batch, saved } = await draftTopicsFromCards('Round', source.cards);
  assert.ok(saved && batch);
  const owner = batch.topics.findIndex(topic => (topic.sourceFindings?.length ?? 0) > 0);
  const other = batch.topics.findIndex((topic, index) => index !== owner);
  assert.ok(owner >= 0 && other >= 0);
  const stolen: DraftBatch = { ...batch, topics: batch.topics.map((topic, index) => index === other
    ? { ...topic, sourceFindings: [...(topic.sourceFindings ?? []), batch.topics[owner].sourceFindings![0]] } : topic) };
  assert.equal(await saveDraftBatch(stolen), false, 'two topics may not own one source finding');
  const historical = batch.topics.findIndex(topic => topic.sourceFindings?.some(finding => finding.membership === 'historical'));
  assert.ok(historical >= 0);
  const promoted: DraftBatch = { ...batch, topics: batch.topics.map((topic, index) => index === historical ? { ...topic,
    sourceFindings: topic.sourceFindings!.map(finding => finding.membership === 'historical' ? { ...finding, membership: 'included' as const } : finding) } : topic) };
  assert.equal(await saveDraftBatch(promoted), false, 'historical evidence is never claimed current');
  act(() => useBcfDraftLibrary.setState({ entries: [] }));
  await bcfDraftLibrary.restore();
  assert.deepEqual(useBcfDraftLibrary.getState().entries.find(entry => entry.id === batch.id), batch, 'the approved draft is unchanged');
});

test('#7373 merge and split keep every source finding with exactly one topic', async t => {
  const source = await reviewed(t, false); if (!source) return;
  const { batch } = await draftTopicsFromCards('Round', source.cards);
  assert.ok(batch);
  const target = batch.topics.find(topic => topic.members.length === 0 && (topic.sourceFindings?.length ?? 0) > 0);
  const clashTopics = batch.topics.filter(topic => topic.members.length > 0);
  assert.ok(target && clashTopics.length >= 2, 'a non-clash topic and two live clash topics');
  const merged = await mergeDraftTopics(batch, [target.guid, ...clashTopics.map(topic => topic.guid)]);
  assert.ok(merged.ok);
  const ids = (topic: DraftTopic | undefined) => (topic?.sourceFindings ?? []).map(finding => finding.id);
  const mergedTopic = merged.batch.topics.find(topic => topic.guid === target.guid);
  assert.deepEqual(ids(mergedTopic), [target, ...clashTopics].flatMap(ids), 'merged topics pool their source findings');
  const split = await splitDraftTopic(merged.batch, target.guid, new Set(clashTopics[0].members.map(findingIdentity)), 'Clash half');
  assert.ok(split.ok, 'a split never makes two topics claim one source finding');
  const kept = split.batch.topics.find(topic => topic.guid === target.guid), moved = split.batch.topics.find(topic => topic.title === 'Clash half');
  assert.deepEqual(ids(kept), ids(mergedTopic), 'source findings stay with the original topic');
  assert.equal(moved?.sourceFindings, undefined);
  assert.deepEqual(moved?.members, clashTopics[0].members);
});
