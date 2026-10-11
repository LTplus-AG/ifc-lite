/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDraftBatch } from '../bcf-drafts/draft-codec';
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
