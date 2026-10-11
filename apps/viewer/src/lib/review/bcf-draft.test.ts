/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBCF, writeBCF } from '@ifc-lite/bcf';
import { DraftArchiveError, draftBatchToProject, exportDraftArchive, importDraftArchive } from '../bcf-drafts/draft-archive';
import { decodeDraftBatch } from '../bcf-drafts/draft-codec';
import type { DraftBatch } from '../bcf-drafts/draft-types';
import { describeWithFooter, parseDraftFooter } from '../bcf-drafts/draft-footer';
import { buildCards } from './cards';
import { cardDigest, cardTitle, draftBatchFromCards } from './bcf-draft';
import { clash, element, fakeModel, finding, run } from './test-support';
import type { ReviewFinding } from './types';

const models = [fakeModel('m1', 'arch.ifc', ['W1', 'W2']), fakeModel('m2', 'mep.ifc', ['P1', 'P2'])];
const wall = (g: string) => element(g, 'arch.ifc', 'm1');
const pipe = (g: string) => element(g, 'mep.ifc', 'm2');
const live = clash('c1', { guid: 'W1', model: 'm1', tag: 'IfcWall' }, { guid: 'P1', model: 'm2', tag: 'IfcPipeSegment' });
const clashFinding = (): ReviewFinding => finding('c1', 'clash', [wall('W1'), pipe('P1')],
  { evidence: { kind: 'clash', clashId: 'c1', occurrenceKey: '', reviewKey: 'k' }, nativeStatus: 'hard' });
const cardsOf = (...findings: ReviewFinding[]) => buildCards(findings, models).cards;
const fixedNow = () => new Date('2026-03-01T00:00:00.000Z');
/** Pinned oracle for the wall/pipe clash card (key 'arch.ifc\u001fW1\nmep.ifc\u001fP1'), computed outside cardDigest. */
const CLASH_CARD_DIGEST = '40844136db37800c';

test('a current clash card becomes one topic with the live clash as its exact member', async () => {
  const [card] = cardsOf(clashFinding());
  const { batch, exclusions } = await draftBatchFromCards('Review', [card], [live], { now: fixedNow });
  assert.deepEqual(exclusions, []);
  assert.equal(batch?.topics.length, 1);
  assert.equal(batch?.topics[0].members.length, 1);
  assert.deepEqual(batch?.topics[0].origin, { kind: 'review', card: CLASH_CARD_DIGEST });
  assert.equal(batch?.source.kind, 'review');
  assert.equal(batch?.createdAt, '2026-03-01T00:00:00.000Z');
});

test('a card whose clash left the live run carries no stale member', async () => {
  const [card] = cardsOf(clashFinding());
  const { batch } = await draftBatchFromCards('Review', [card], [], { now: fixedNow });
  assert.equal(batch?.topics[0].members.length, 0);
  assert.equal(batch?.topics[0].topicType, 'Issue');
});

test('a validation-only card is drafted from its validated elements, selected in the viewpoint', async () => {
  const [card] = cardsOf(finding('v1', 'validation', [wall('W2')], { nativeStatus: 'failed' }));
  const { batch } = await draftBatchFromCards('Review', [card], [], { now: fixedNow });
  assert.deepEqual(batch?.topics[0].viewpoint?.components?.selection, [{ ifcGuid: 'W2' }]);
  assert.match(batch?.topics[0].description ?? '', /validation, current/);
});

// Invariant: nothing is drafted silently: a card with a topic or without current evidence is excluded and reported.
test('cards that already have a BCF topic or hold only historical evidence are excluded and reported', async () => {
  const historical = run('clash:baseline', 'clash', { temporal: 'historical' });
  const withTopic = cardsOf(clashFinding(), finding('t', 'bcf', [wall('W1'), pipe('P1')], { lifecycle: 'record', evidence: { kind: 'bcf', topicGuid: 'T1' } }))[0];
  const old = cardsOf(finding('h', 'clash', [wall('W2')], { run: historical, lifecycle: 'not-evaluated' }))[0];
  const { batch, exclusions } = await draftBatchFromCards('Review', [withTopic, old], [live], { now: fixedNow });
  assert.equal(batch, null);
  assert.deepEqual(exclusions.map(item => item.reason).sort(), ['has-topic', 'not-current']);
});

test('a drafted batch survives the durable draft codec unchanged', async () => {
  const [card] = cardsOf(clashFinding());
  const { batch } = await draftBatchFromCards('Review', [card], [live], { now: fixedNow });
  assert.deepEqual(decodeDraftBatch(JSON.parse(JSON.stringify(batch))), batch);
});

test('card titles name the elements and fall back to the first finding', () => {
  const [named] = cardsOf(finding('v', 'validation', [{ ...wall('W1'), name: 'Wall A' }]));
  assert.equal(cardTitle(named), 'IfcWall Wall A');
  const [bare] = cardsOf(finding('x', 'linked', []));
  assert.equal(cardTitle(bare), 'x');
});

test('the archive footer of a review topic keeps its card origin, so a published topic still names its card', async () => {
  const [card] = cardsOf(clashFinding());
  const { batch } = await draftBatchFromCards('Review', [card], [live], { now: fixedNow });
  const topic = batch!.topics[0];
  const parsed = parseDraftFooter(describeWithFooter(topic, { batchId: batch!.id, full: { batchName: batch!.name, source: batch!.source } }));
  assert.deepEqual(parsed?.origin, { kind: 'review', card: CLASH_CARD_DIGEST });
});

test('a card digest is pinned to the card key and distinguishes keys', () => {
  assert.equal(cardDigest({ key: 'arch.ifc\u001fW1\nmep.ifc\u001fP1' }), CLASH_CARD_DIGEST);
  assert.equal(cardDigest({ key: 'card-a' }), '59bbf293d8a76e35');
  assert.equal(cardDigest({ key: 'card-b' }), '58bbf100d5a7697c');
});

// #7373: without a wasm runtime too, non-clash card findings keep their exact
// review id, native evidence and owning run, and are counted only when current.
test('non-clash findings are kept as source findings with their run and membership, and counted only when current', async () => {
  const saved = run('saved-validation:r1', 'validation', { temporal: 'historical', capturedAt: '2026-01-01T00:00:00.000Z', complete: false,
    incomplete: [{ code: 'partial-source' }], models: ['arch.ifc'] });
  const live = finding('v1', 'validation', [wall('W2')], { nativeStatus: 'failed',
    evidence: { kind: 'validation', specificationId: 's1', modelId: 'm1', expressId: 2 } });
  const old = finding('v0', 'validation', [wall('W2')], { run: saved, lifecycle: 'not-evaluated',
    evidence: { kind: 'saved-validation', reportId: 'r1', rowId: 'row-2' } });
  const [card] = cardsOf(live, old);
  const { batch } = await draftBatchFromCards('Review', [card], [], { now: fixedNow });
  const kept = batch!.topics[0].sourceFindings;
  assert.deepEqual(kept?.map(item => [item.id, item.membership, item.run.temporal, item.run.capturedAt]),
    [[live.id, 'included', 'current', null], [old.id, 'historical', 'historical', '2026-01-01T00:00:00.000Z']]);
  assert.deepEqual(kept?.[1].run.gaps, ['partial-source']);
  assert.deepEqual(kept?.[0].evidence, live.evidence);
  assert.equal(batch!.source.findingCount, 1, 'saved evidence is described, never counted as current');
  assert.deepEqual(decodeDraftBatch(JSON.parse(JSON.stringify(batch))), batch);
  const parsed = parseDraftFooter(describeWithFooter(batch!.topics[0], { batchId: batch!.id, full: { batchName: batch!.name, source: batch!.source } }));
  assert.deepEqual(parsed?.sourceFindings, kept);
});

// #7373 follow-up: a grouping receipt is a coordination record; its native status stays authoritative,
// so it is kept as a `record`, never re-labelled historical by its saved run.
test('a grouping receipt on a card is kept as a record source finding, not as historical evidence', async () => {
  const receiptRun = run('["clash-group-application","a1"]', 'clash', { temporal: 'historical', capturedAt: '2026-02-01T00:00:00.000Z',
    complete: false, incomplete: [{ code: 'partial-source' }] });
  const receipt = finding('g1', 'clash', [wall('W2')], { run: receiptRun, lifecycle: 'record', nativeStatus: 'applied',
    evidence: { kind: 'clash-group-application', applicationId: 'a1', groupId: 'g1' } });
  const failed = finding('v1', 'validation', [wall('W2')], { nativeStatus: 'failed',
    evidence: { kind: 'validation', specificationId: 's1', modelId: 'm1', expressId: 2 } });
  const [card] = cardsOf(failed, receipt);
  const { batch } = await draftBatchFromCards('Review', [card], [], { now: fixedNow });
  const kept = batch!.topics[0].sourceFindings;
  assert.deepEqual(kept?.map(item => [item.id, item.membership]), [[failed.id, 'included'], [receipt.id, 'record']]);
  assert.equal(kept?.[1].nativeStatus, 'applied');
  assert.equal(batch!.source.findingCount, 1, 'a record is described, never counted as a current finding');
  assert.deepEqual(decodeDraftBatch(JSON.parse(JSON.stringify(batch))), batch);
});

async function reviewArchive() {
  const first = cardsOf(finding('v1', 'validation', [wall('W2')], { nativeStatus: 'failed',
    evidence: { kind: 'validation', specificationId: 's1', modelId: 'm1', expressId: 2 } }))[0];
  const second = cardsOf(finding('v2', 'validation', [pipe('P2')], { nativeStatus: 'failed',
    evidence: { kind: 'validation', specificationId: 's1', modelId: 'm2', expressId: 2 } }))[0];
  const { batch } = await draftBatchFromCards('Review', [first, second], [], { now: fixedNow });
  assert.ok(batch && batch.topics.length === 2);
  assert.ok(batch.topics.every(topic => topic.sourceFindings?.length === 1));
  return batch;
}

/** Three live wall/pipe clashes on one card, optionally with a current validation finding on the same elements. */
async function clashReview(withSources: boolean) {
  const clashes = [0, 1, 2].map(at => clash(`c${at}`, { guid: 'W1', model: 'm1', tag: 'IfcWall' }, { guid: 'P1', model: 'm2', tag: 'IfcPipeSegment' },
    { rule: `rule-${at}`, point: [at, 0, 0], bounds: { min: [at, 0, 0], max: [at + 1, 1, 1] } }));
  const findings = clashes.map(item => finding(item.id, 'clash', [wall('W1'), pipe('P1')],
    { evidence: { kind: 'clash', clashId: item.id, occurrenceKey: '', reviewKey: item.id }, nativeStatus: 'hard' }));
  if (withSources) findings.push(finding('v1', 'validation', [wall('W1'), pipe('P1')], { nativeStatus: 'failed',
    evidence: { kind: 'validation', specificationId: 's1', modelId: 'm1', expressId: 1 } }));
  const cards = cardsOf(...findings);
  assert.equal(cards.length, 1);
  const { batch } = await draftBatchFromCards('Review', cards, clashes, { now: fixedNow });
  assert.ok(batch && batch.topics[0].members.length === 3);
  assert.equal(batch.topics[0].sourceFindings?.length, withSources ? 1 : 0);
  return batch;
}

/** Export, replace the topic's origin line (not digest covered), and import the real bytes again. */
async function withOrigin(batch: DraftBatch, origin: string) {
  const project = await readBCF(await (await exportDraftArchive(batch, 'a@example.test')).arrayBuffer());
  const edited = project.topics.get(batch.topics[0].guid)!;
  const before = edited.description!;
  edited.description = before.replace(/\norigin: [^\n]+/, `\norigin: ${origin}`);
  assert.notEqual(edited.description, before);
  return importDraftArchive(await (await writeBCF(project)).arrayBuffer());
}

/** Unparsable, non-review, and review origins the codec refuses (empty card, card over 100 chars). */
const BROKEN_ORIGINS = ['%7Bbroken', ...[{ kind: 'selection' }, { kind: 'review', card: '' }, { kind: 'review', card: 'c'.repeat(101) }]
  .map(origin => encodeURIComponent(JSON.stringify(origin)))];

// Before #7373 a clash topic with a broken origin degraded to an archive topic with its verified members.
test('a clash-only review topic whose origin line no longer reads keeps every clash member and is not reported damaged', async () => {
  const batch = await clashReview(false);
  for (const origin of BROKEN_ORIGINS) {
    const imported = await withOrigin(batch, origin);
    assert.equal(imported.damaged, 0, 'no reviewed finding was lost');
    assert.equal(imported.unmapped, 0);
    const [topic] = imported.batches.flatMap(entry => entry.topics);
    assert.deepEqual(topic.members, batch.topics[0].members, 'all 3 digest-verified clash members');
    assert.deepEqual(topic.origin, { kind: 'archive' }, `degraded to archive for origin ${origin}`);
    assert.equal(topic.sourceFindings, undefined);
  }
});

test('a clash-only topic declaring no source findings is not reported as losing any, even beside a stray source line', async () => {
  const batch = await clashReview(false);
  const project = await readBCF(await (await exportDraftArchive(batch, 'a@example.test')).arrayBuffer());
  const edited = project.topics.get(batch.topics[0].guid)!;
  edited.description = `${edited.description!.replace(/\norigin: [^\n]+/, `\norigin: ${BROKEN_ORIGINS[1]}`)}`
    + `\nsources: 0 0000000000000000\ns: ${encodeURIComponent(JSON.stringify({ id: 'stray' }))}`;
  const imported = await importDraftArchive(await (await writeBCF(project)).arrayBuffer());
  assert.equal(imported.damaged, 0);
  assert.equal(imported.droppedFindings, 0, 'zero declared findings: none was lost');
  const [topic] = imported.batches.flatMap(entry => entry.topics);
  assert.deepEqual(topic.members, batch.topics[0].members);
  assert.deepEqual(topic.origin, { kind: 'archive' });
});

test('a review topic with source findings and a broken origin keeps its members, drops its findings and is reported damaged', async () => {
  const batch = await clashReview(true);
  for (const origin of BROKEN_ORIGINS) {
    const imported = await withOrigin(batch, origin);
    assert.equal(imported.damaged, 1);
    assert.equal(imported.droppedFindings, 1);
    assert.equal(imported.unmapped, 0);
    const [topic] = imported.batches.flatMap(entry => entry.topics);
    assert.deepEqual(topic.members, batch.topics[0].members);
    assert.deepEqual(topic.origin, { kind: 'archive' }, `degraded to archive for origin ${origin}`);
    assert.equal(topic.sourceFindings, undefined, 'source findings are never re-homed onto a non-review topic');
  }
});

// The untouched topic of the same archive keeps its provenance.
test('a broken origin on one review topic leaves the other topics of the archive intact', async () => {
  const batch = await reviewArchive();
  const imported = await withOrigin(batch, BROKEN_ORIGINS[0]);
  assert.equal(imported.damaged, 1);
  const topics = imported.batches.flatMap(entry => entry.topics);
  assert.equal(topics.find(topic => topic.guid === batch.topics[0].guid)?.sourceFindings, undefined);
  assert.deepEqual(topics.find(topic => topic.guid === batch.topics[1].guid)?.sourceFindings, batch.topics[1].sourceFindings);
});

test('an archive that maps one reviewed finding to two topics is refused with that exact reason', async () => {
  const batch = await reviewArchive();
  const [owner, other] = batch.topics;
  // Export refuses such a batch, so write a consistent footer (count and digest) claiming the owner's finding by hand.
  const project = draftBatchToProject(batch, 'a@example.test');
  project.topics.get(other.guid)!.description = describeWithFooter({ ...other, sourceFindings: [...other.sourceFindings!, owner.sourceFindings![0]] },
    { batchId: batch.id, full: { batchName: batch.name, source: batch.source } });
  const bytes = await (await writeBCF(project)).arrayBuffer();
  await assert.rejects(importDraftArchive(bytes), (error: unknown) => error instanceof DraftArchiveError && error.reason === 'source-finding'
    && /reviewed finding/.test(error.message) && !/clash/.test(error.message));
});
