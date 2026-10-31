// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6961: the field verdict applies the ledger's paired-ratio method per journey
// and per perf-flag arm, offline, to a PostHog HogQL result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fixtureRows from './field-verdict.fixture.json' with { type: 'json' };

const VERDICT = new URL('./field-verdict.mjs', import.meta.url);
const FETCH = new URL('./field-verdict-fetch.mjs', import.meta.url);
const FIXTURE = new URL('./field-verdict.fixture.json', import.meta.url);

// Loaded after asserting the module exists, so a reverted script fails these
// tests on an assertion rather than as a file that cannot load.
async function load(url) {
  assert.ok(existsSync(url), `${fileURLToPath(url)} must exist`);
  return import(url.href);
}

const fixture = () => fixtureRows;
const find = (groups, key) => groups.find((g) => Object.entries(key).every(([k, v]) => g[k] === v));

test('#6961 pairs only same person, same model cells with a default-arm baseline divisor', async () => {
  const { parseRows, pairCells } = await load(VERDICT);
  const cells = pairCells(parseRows(fixture()));
  const people = new Set(cells.map((c) => c.person));
  // A recent-only person, a divisor recorded in a ramp arm, a zero divisor and
  // the same person on another model can never form a cell.
  for (const trap of ['solo', 'armed', 'zero']) assert.ok(!people.has(trap), `${trap} must not pair`);
  assert.ok(!cells.some((c) => c.model === 'ifc:other'));
  assert.equal(cells.length, 6 + 3 + 5);
});

const row = (person, metric, window, median, extra = {}) => ({ event: 'ifc_model_loaded', journey: 'J1', arm: 'default', person, model: 'ifc:1', metric, window, median, n: 2, ...extra });
const paired = (person, ratio, extra = {}, metric = 'total_elapsed_ms') => [row(person, metric, 'baseline', 100, extra), row(person, metric, 'recent', 100 * ratio, extra)];
const people = (count, ratio, metric) => Array.from({ length: count }, (_, i) => paired(`p${i}`, ratio, {}, metric)).flat();

test('#6961 a group is judged by the median person, per journey', async () => {
  const { parseRows, fieldVerdict } = await load(VERDICT);
  const verdict = fieldVerdict(parseRows(fixture()), { threshold: 0.95, minPersons: 5 });
  const firstPixel = find(verdict.groups, { metric: 'first_visible_geometry_ms', journey: 'J1', arm: 'default' });
  assert.equal(firstPixel.persons, 6);
  assert.equal(firstPixel.ratio, 1.175); // median of 1.0, 1.1, 1.15, 1.2, 1.25, 1.3
  assert.equal(firstPixel.speed, 0.851);

  // Twice as slow, but three people is not a verdict: undefined, not small.
  const warm = find(verdict.groups, { metric: 'total_elapsed_ms', journey: 'J2' });
  assert.equal(warm.ratio, 2);
  assert.equal(warm.status, 'insufficient');
});

// Build 8d3ffe9d1f62's shape: two people's batches outnumber everyone else's cells.
test('#6961 one federated batch cannot outvote other people', async () => {
  const { fieldVerdict } = await load(VERDICT);
  const rows = [];
  for (const person of ['batch-a', 'batch-b']) {
    for (let m = 0; m < 14; m++) rows.push(...paired(person, 4.7, { journey: 'J4', model: `ifc:${m}` }));
  }
  for (let i = 0; i < 13; i++) rows.push(...paired(`solo${i}`, 0.96, { journey: 'J4' }));
  const group = fieldVerdict(rows).groups[0];
  assert.equal(group.cells, 41);
  assert.equal(group.persons, 15);
  assert.equal(group.ratio, 0.96);
  assert.equal(group.status, 'flat');
});

test('#6961 regressed needs the interval to exclude 1, not only a point past the threshold', async () => {
  const { fieldVerdict } = await load(VERDICT);
  const clear = fieldVerdict(people(8, 1.3));
  assert.equal(clear.groups[0].status, 'regressed');
  assert.deepEqual(clear.regressed.map((g) => g.metric), ['total_elapsed_ms']);
  assert.equal(fieldVerdict(people(8, 0.7)).groups[0].status, 'improved');

  // The median is 1.1, past the threshold, but half the people got faster.
  const spread = [0.5, 0.6, 0.7, 0.9, 1.1, 1.3, 1.5, 1.8, 2.2].flatMap((ratio, i) => paired(`p${i}`, ratio));
  const noisy = fieldVerdict(spread);
  assert.equal(noisy.groups[0].ratio, 1.1);
  assert.equal(noisy.groups[0].status, 'inconclusive');
  assert.equal(noisy.regressed.length, 0);
});

test('#6961 the verdict is deterministic for one input', async () => {
  const { fieldVerdict } = await load(VERDICT);
  const rows = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4].flatMap((ratio, i) => paired(`p${i}`, ratio));
  assert.deepEqual(fieldVerdict(rows), fieldVerdict(rows));
});

test('#6961 context metrics are never judged, and a moved file read warns', async () => {
  const { fieldVerdict, renderMarkdown } = await load(VERDICT);
  const verdict = fieldVerdict(people(8, 2, 'file_read_ms'));
  assert.equal(verdict.groups[0].status, 'context');
  assert.equal(verdict.regressed.length, 0);
  assert.equal(verdict.controlMoved.length, 1);
  assert.match(renderMarkdown(verdict), /Treat load results as suspect in J1/);
  assert.doesNotMatch(renderMarkdown(fieldVerdict(people(8, 1, 'file_read_ms'))), /suspect/);
  assert.equal(fieldVerdict(people(8, 2, 'federated_session_loads')).regressed.length, 0);
});

test('#6961 a group inside the band is flat, and no paired cell says so plainly', async () => {
  const { fieldVerdict, renderMarkdown } = await load(VERDICT);
  const rows = people(5, 1.02);
  assert.equal(fieldVerdict(rows).groups[0].status, 'flat');
  // Paired cells exist, but no group reached minPersons: insufficient, never a pass.
  const thin = fieldVerdict(rows, { minPersons: 6 });
  assert.equal(thin.groups[0].status, 'insufficient');
  const thinMd = renderMarkdown(thin);
  assert.match(thinMd, /Insufficient paired data/);
  assert.doesNotMatch(thinMd, /No group regressed/);
  const empty = fieldVerdict([]);
  assert.equal(empty.cells, 0);
  assert.match(renderMarkdown(empty, { build: 'abc123def456' }), /No \(person, model\) cell has loads in both windows/);
});

test('#6961 markdown names the build, the regression count and the row', async () => {
  const { fieldVerdict, renderMarkdown } = await load(VERDICT);
  const md = renderMarkdown(fieldVerdict(people(5, 1.2, 'stream_complete_ms')), { build: '3c3cb1fada2f' });
  assert.match(md, /Field verdict for build `3c3cb1fada2f`/);
  assert.match(md, /\*\*1 group\(s\) regressed\*\*/);
  assert.match(md, /\| ifc_model_loaded \| J1 \| stream_complete_ms \| `default` \| 5 \| 5 \| 1\.2 \(1\.2-1\.2\) \| 0\.833 \| regressed \|/);
});

test('#6961 the CLI exits 2 on a regression only when asked to', async () => {
  await load(VERDICT);
  const dir = mkdtempSync(join(tmpdir(), 'field-verdict-'));
  const input = join(dir, 'rows.json');
  writeFileSync(input, JSON.stringify(people(8, 1.3)));
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(VERDICT), input, ...args], { encoding: 'utf8' });
  try {
    assert.equal(run().status, 0);
    // A malformed bound would turn "insufficient" into a verdict; it is refused instead.
    for (const bad of [['--min-persons', '5x'], ['--min-persons', '0'], ['--threshold', 'abc'], ['--threshold', '1.5']]) {
      const refused = run(...bad);
      assert.equal(refused.status, 1, bad.join(' '));
      assert.match(refused.stderr, /must be/);
    }
    const failing = run('--fail-on-regression', '--json');
    assert.equal(failing.status, 2, failing.stderr);
    assert.equal(JSON.parse(failing.stdout).regressed.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#6961 rows: the query API shape and plain objects both parse; malformed rows are refused', async () => {
  const { parseRows } = await load(VERDICT);
  const [row] = parseRows({ columns: ['event', 'journey', 'arm', 'person', 'model', 'metric', 'window', 'median', 'n'], results: [['viewer_boot', 'J0', 'default', 'p', '-', 'drop_target_ms', 'recent', '812', '3']] });
  assert.equal(row.median, 812);
  assert.equal(row.n, 3);
  assert.throws(() => parseRows({ results: [{ event: 'x' }] }), /has no journey/);
  assert.throws(() => parseRows([{ event: 'x', journey: 'J1', arm: 'default', person: 'p', model: 'm', metric: 'm', window: 'later', median: 1, n: 1 }]), /baseline\|recent/);
});

test('#6961 the HogQL comes from the README block, filled in, with a validated build', async () => {
  const { verdictSql } = await load(VERDICT);
  const sql = verdictSql({ build: '3c3cb1fada2fdeadbeef', baselineDays: 21 });
  assert.ok(!sql.includes('__BUILD__') && !sql.includes('__BASELINE_DAYS__'), 'every placeholder is filled');
  assert.match(sql, /app_build_sha\) = '3c3cb1fada2f'/, 'the build is the 12-character app_build_sha');
  assert.match(sql, /INTERVAL 21 DAY/);
  assert.throws(() => verdictSql({ build: "x' OR 1=1 --" }), /hex commit sha/);
  assert.throws(() => verdictSql({ build: 'abcdef123456', readme: 'no block here' }), /no sql block/);
  // Events carry the 12-character app_build_sha; a short prefix would match nothing.
  assert.throws(() => verdictSql({ build: '3c3cb1f' }), /at least 12 characters/);
  assert.ok(!/\bLIMIT\b/.test(sql), 'the fetch adds the LIMIT, the README block has none');
});

test('#6961 the fetch is one read-only query POST under a row cap, never partial', async () => {
  const { fetchVerdictRows, MAX_ROWS } = await load(FETCH);
  const calls = [];
  const replies = (status, body) => async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  const rows = await fetchVerdictRows({ sql: 'SELECT 1', apiKey: 'k', fetchImpl: replies(200, { columns: ['a'], results: [[1]] }) });
  assert.deepEqual(rows, { columns: ['a'], results: [[1]] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://eu.posthog.com/api/projects/199147/query/');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(calls[0].init.body).query, { kind: 'HogQLQuery', query: `SELECT 1\nLIMIT ${MAX_ROWS}` });
  // PostHog answers 400 to OFFSET on a personal API key, so it can never be sent.
  assert.doesNotMatch(calls[0].init.body, /OFFSET/);

  // A result at the cap, or one PostHog says continues, fails instead of judging a partial result.
  await assert.rejects(
    fetchVerdictRows({ sql: 'SELECT a', apiKey: 'k', maxRows: 2, fetchImpl: replies(200, { columns: ['a'], results: [[1], [2]] }) }),
    /reached the 2 cell row cap/,
  );
  await assert.rejects(
    fetchVerdictRows({ sql: 'SELECT a', apiKey: 'k', fetchImpl: replies(200, { columns: ['a'], results: [[1]], hasMore: true }) }),
    /row cap/,
  );
  await assert.rejects(fetchVerdictRows({ sql: 'SELECT a LIMIT 5', apiKey: 'k', fetchImpl: replies(200, {}) }), /must not carry its own LIMIT/);
  await assert.rejects(fetchVerdictRows({ sql: 's', apiKey: '', fetchImpl: replies(200, {}) }), /POSTHOG_PERSONAL_API_KEY/);
  await assert.rejects(fetchVerdictRows({ sql: 's', apiKey: 'k', fetchImpl: replies(403, { detail: 'no' }) }), /answered 403/);
});
