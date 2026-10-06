// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6961: the field verdict applies the ledger's paired-ratio method per journey
// and per perf-flag arm, offline, to a PostHog HogQL result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERDICT = new URL('./field-verdict.mjs', import.meta.url);
const FETCH = new URL('./field-verdict-fetch.mjs', import.meta.url);
const FIXTURE = new URL('./field-verdict.fixture.json', import.meta.url);

// Loaded after asserting the module exists, so a reverted script fails these
// tests on an assertion rather than as a file that cannot load.
async function load(url) {
  assert.ok(existsSync(url), `${fileURLToPath(url)} must exist`);
  return import(url.href);
}

const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
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

test('#6961 pooled ratio is the median of cell ratios; speed below 0.95 with enough cells regresses', async () => {
  const { parseRows, fieldVerdict } = await load(VERDICT);
  const verdict = fieldVerdict(parseRows(fixture()), { threshold: 0.95, minCells: 5 });

  const firstPixel = find(verdict.pooled, { event: 'ifc_model_loaded', metric: 'first_visible_geometry_ms', arm: 'default' });
  assert.equal(firstPixel.cells, 6);
  assert.equal(firstPixel.ratio, 1.175); // median of 1.0, 1.1, 1.15, 1.2, 1.25, 1.3
  assert.equal(firstPixel.speed, 0.851);
  assert.equal(firstPixel.status, 'regressed');

  // Twice as slow, but three cells is not a verdict: undefined, not small.
  const warm = find(verdict.perJourney, { metric: 'total_elapsed_ms', journey: 'J2' });
  assert.equal(warm.ratio, 2);
  assert.equal(warm.status, 'insufficient');

  // A ramp arm is judged against the same people's default-arm baseline.
  const inspect = find(verdict.pooled, { event: 'ifc_inspect', arm: 'quantized=false' });
  assert.equal(inspect.ratio, 0.8);
  assert.equal(inspect.status, 'improved');

  assert.deepEqual(verdict.regressed.map((g) => g.metric), ['first_visible_geometry_ms']);
});

test('#6961 a group inside the band is flat, and no paired cell says so plainly', async () => {
  const { fieldVerdict, renderMarkdown } = await load(VERDICT);
  const rows = [];
  for (let i = 0; i < 5; i++) {
    for (const [window, median] of [['baseline', 100], ['recent', 102]]) {
      rows.push({ event: 'ifc_navigate', journey: 'J6', arm: 'default', person: `p${i}`, model: 'ifc:1', metric: 'frame_p95_ms', window, median, n: 1 });
    }
  }
  assert.equal(fieldVerdict(rows).pooled[0].status, 'flat');
  const empty = fieldVerdict([]);
  assert.equal(empty.cells, 0);
  assert.match(renderMarkdown(empty, { build: 'abc123def456' }), /No \(person, model\) cell has loads in both windows/);
});

test('#6961 markdown names the build, the regression count and the pooled row', async () => {
  const { fieldVerdict, renderMarkdown } = await load(VERDICT);
  const rows = [];
  for (let i = 0; i < 5; i++) {
    for (const [window, median] of [['baseline', 100], ['recent', 120]]) {
      rows.push({ event: 'ifc_model_loaded', journey: 'J1', arm: 'default', person: `p${i}`, model: 'ifc:1', metric: 'stream_complete_ms', window, median, n: 2 });
    }
  }
  const md = renderMarkdown(fieldVerdict(rows), { build: '3c3cb1fada2f' });
  assert.match(md, /Field verdict for build `3c3cb1fada2f`/);
  assert.match(md, /\*\*1 pooled group\(s\) regressed\*\*/);
  assert.match(md, /\| ifc_model_loaded \| stream_complete_ms \| `default` \| 5 \| 5 \| 1\.2 \(1\.2-1\.2\) \| 0\.833 \| regressed \|/);
});

test('#6961 the CLI exits 2 on a regression only when asked to', async () => {
  await load(VERDICT);
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(VERDICT), fileURLToPath(FIXTURE), ...args], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  const failing = run('--fail-on-regression', '--json');
  assert.equal(failing.status, 2, failing.stderr);
  assert.equal(JSON.parse(failing.stdout).regressed.length, 1);
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
  assert.throws(() => verdictSql({ build: 'abcdef1', readme: 'no block here' }), /no sql block/);
});

test('#6961 the fetch is one read-only query POST, and a truncated result is an error', async () => {
  const { fetchVerdictRows } = await load(FETCH);
  const calls = [];
  const reply = (status, body) => async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  const rows = await fetchVerdictRows({ sql: 'SELECT 1', apiKey: 'k', fetchImpl: reply(200, { columns: ['a'], results: [[1]] }) });
  assert.deepEqual(rows, { columns: ['a'], results: [[1]] });
  assert.equal(calls[0].url, 'https://eu.posthog.com/api/projects/199147/query/');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(calls[0].init.body).query, { kind: 'HogQLQuery', query: 'SELECT 1' });
  await assert.rejects(fetchVerdictRows({ sql: 's', apiKey: '', fetchImpl: reply(200, {}) }), /POSTHOG_PERSONAL_API_KEY/);
  await assert.rejects(fetchVerdictRows({ sql: 's', apiKey: 'k', fetchImpl: reply(403, { detail: 'no' }) }), /answered 403/);
  await assert.rejects(fetchVerdictRows({ sql: 's', apiKey: 'k', fetchImpl: reply(200, { columns: [], results: [], hasMore: true }) }), /truncated/);
});
