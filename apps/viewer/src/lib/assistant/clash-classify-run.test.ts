/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Clash } from '@ifc-lite/clash';
import { createRootBudget } from '../llm/root-budget';
import type { SendableRoute } from '../llm/request-service';
import { manualClashOccurrenceKey } from '../clash/manual-groups';
import { CLASSIFY_ROOT_BUDGET, estimateClassification, planClassification } from './clash-classify-chunks';
import { draftFromClassification, runClassification, type ChunkResult, type ClassifyRunOptions, type ClassifyRunResult } from './clash-classify-run';
import { draftAccounting } from './clash-group-draft';
import { clashFindings, serveClassifier } from '@/test/clash-classifier-stub';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const route: SendableRoute = { kind: 'proxy', model: 'test/free-model' };
function options(clashes: Clash[], overrides: Partial<ClassifyRunOptions> = {}): ClassifyRunOptions {
  return { plan: planClassification(clashes), route, proxyUrl: '/api/chat', budget: createRootBudget(CLASSIFY_ROOT_BUDGET),
    signal: new AbortController().signal, allowNormalization: false, isCurrent: () => true, ...overrides };
}
/**
 * Independent of how `runClassification` derives `unclassified`: grouped is the number of distinct native
 * occurrences in the merged groups (a finding grouped twice would make the buckets disagree), and no bucket is negative.
 */
function assertAccounted({ accounting, merged, chunks }: ClassifyRunResult) {
  const occurrences = merged.flatMap(group => group.findings.map(finding => finding.occurrence));
  assert.equal(new Set(occurrences).size, occurrences.length, 'no finding is grouped twice');
  assert.equal(accounting.grouped, occurrences.length, 'grouped counts the merged findings');
  for (const [bucket, count] of Object.entries(accounting)) assert.ok(count >= 0, `${bucket} is not negative`);
  // Chunk coverage, read from the per-chunk statuses rather than the accounting: the rows of answered chunks are
  // grouped or unclassified, the rest failed or not run.
  const rowsWith = (statuses: string[]) => chunks.filter(chunk => statuses.includes(chunk.status)).reduce((sum, chunk) => sum + chunk.rows, 0);
  assert.equal(accounting.grouped + accounting.unclassified, rowsWith(['accepted', 'adjusted']), 'answered chunks hold exactly the grouped and unclassified findings');
  assert.equal(rowsWith(['accepted', 'adjusted', 'invalid', 'failed', 'cancelled', 'not-run']), accounting.total - accounting.unaddressable, 'every addressable finding is in one chunk');
  assert.equal(accounting.grouped + accounting.unclassified + accounting.failed + accounting.notRun + accounting.unaddressable, accounting.total,
    'every native finding is in exactly one bucket');
}

// #6906: classification covers the whole native run, not only the 100-row discussion sample.
test('250 findings page into 3 chunks with chunk-local citations, progress and a deterministic merge', async () => {
  const clashes = clashFindings(250);
  const requests = serveClassifier();
  const progress: number[] = [];
  const onProgress = (chunks: readonly ChunkResult[]) => progress.push(chunks.filter(chunk => chunk.status === 'accepted').length);
  const result = await runClassification(options(clashes, { onProgress }));
  assert.deepEqual(requests.map(request => [request.chunk, request.citations.length, request.citations[0], request.citations.at(-1)]),
    [[1, 100, 'E1', 'E100'], [2, 100, 'E1', 'E100'], [3, 50, 'E1', 'E50']]);
  assert.deepEqual([...new Set(progress)], [0, 1, 2, 3], 'progress reports every completed chunk');
  assert.deepEqual(result.chunks.map(chunk => chunk.status), ['accepted', 'accepted', 'accepted']);
  assert.equal(result.partial, false);
  assert.deepEqual(result.merged.map(group => [group.name, group.chunks, group.findings.length]),
    [['Major walls/pipes', [1, 2, 3], 125], ['Minor walls/pipes', [1, 2, 3], 100]], 'names fold across chunks; the first spelling wins');
  assert.deepEqual(result.accounting, { total: 250, grouped: 225, unclassified: 25, failed: 0, notRun: 0, unaddressable: 0 });
  assertAccounted(result);
  // Chunk citations map back to native occurrences: C2/E1 is the 101st finding.
  const c2 = result.merged[0].findings.find(finding => finding.citation === 'C2/E1')!;
  assert.equal(c2.occurrence, manualClashOccurrenceKey(clashes[100]));
  assert.equal(c2.nativeSeverity, 'major');
  serveClassifier();
  const again = await runClassification(options(clashes));
  assert.deepEqual(again.merged, result.merged, 'the same answers merge to the same groups');
  const draft = draftFromClassification(result);
  assert.deepEqual(draftAccounting(draft), { groups: 2, grouped: 225, unclassified: 25, unclassifiedByReview: 0, failed: 0, notRun: 0 });
});

test('the budget is checked before starting and still bounds the run', async () => {
  const plan = planClassification(clashFindings(250));
  assert.deepEqual(estimateClassification(plan, CLASSIFY_ROOT_BUDGET, 4096), { chunks: 3, requests: 3, outputTokens: 12_288, fits: true });
  assert.equal(estimateClassification(plan, { maxRequests: 2, maxOutputTokens: 100_000 }, 4096).fits, false);
  assert.equal(estimateClassification(plan, { maxRequests: 10, maxOutputTokens: 10_000 }, 4096).fits, false);
  // Even a caller that skips the estimate cannot exceed the root: the third chunk is refused without a request.
  const requests = serveClassifier();
  const result = await runClassification(options(clashFindings(250), { budget: createRootBudget({ maxRequests: 2, maxOutputTokens: 100_000 }) }));
  assert.equal(requests.length, 2);
  assert.deepEqual(result.chunks.map(chunk => [chunk.status, chunk.reason]), [['accepted', undefined], ['accepted', undefined], ['failed', 'budget-exhausted']]);
  assert.equal(result.partial, true);
  assert.equal(result.accounting.failed, 50);
  assertAccounted(result);
});

test('cancelling mid-run keeps accepted chunks as a partial result and accounts for the rest', async () => {
  const requests = serveClassifier({ hangOnChunk: 2 });
  const controller = new AbortController();
  const running = runClassification(options(clashFindings(250), { signal: controller.signal }));
  while (requests.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  const result = await running;
  assert.equal(requests.length, 2, 'nothing is sent after cancel');
  assert.deepEqual(result.chunks.map(chunk => chunk.status), ['accepted', 'cancelled', 'not-run']);
  assert.equal(result.partial, true);
  assert.deepEqual(result.accounting, { total: 250, grouped: 90, unclassified: 10, failed: 0, notRun: 150, unaddressable: 0 });
  const draft = draftFromClassification(result);
  assert.equal(draft.origin.kind === 'full-run' && draft.origin.partial, true, 'the review labels the result partial');
});

test('an invalid chunk answer is normalized only with consent, and the adjustment is disclosed', async () => {
  serveClassifier({ repeatInChunk: 2 });
  const strict = await runClassification(options(clashFindings(250)));
  assert.equal(strict.chunks[1].status, 'invalid');
  assert.match(strict.chunks[1].reason ?? '', /unique captured evidence citations/);
  assert.equal(strict.accounting.failed, 100);
  assertAccounted(strict);
  serveClassifier({ repeatInChunk: 2 });
  const consented = await runClassification(options(clashFindings(250), { allowNormalization: true }));
  assert.equal(consented.chunks[1].status, 'adjusted');
  assert.deepEqual(consented.chunks[1].adjustments, { repeats: 1, unknown: 0, groups: 0 });
  assert.equal(consented.accounting.grouped, 225);
  assertAccounted(consented);
});

test('a native rerun during classification discards the answers instead of mixing populations', async () => {
  const requests = serveClassifier();
  let current = true;
  const result = await runClassification(options(clashFindings(250), {
    isCurrent: () => current, onProgress: chunks => { if (chunks[0].status === 'accepted') current = false; } }));
  assert.equal(requests.length, 1);
  assert.equal(result.stale, true);
  assert.deepEqual(result.merged, []);
  assert.deepEqual(result.chunks.map(chunk => chunk.status), ['not-run', 'not-run', 'not-run']);
  assertAccounted(result);
});

test('findings sharing one occurrence identity are counted as unaddressable, never chunked', () => {
  const clashes = clashFindings(3);
  clashes.push({ ...clashes[0], id: 'duplicate' });
  const plan = planClassification(clashes);
  assert.deepEqual(plan.unaddressable.map(clash => clash.id), ['f-0', 'duplicate']);
  assert.equal(plan.chunks[0].rows.length, 2);
});
