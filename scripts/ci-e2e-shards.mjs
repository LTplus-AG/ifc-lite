#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which spec files each `Viewer E2E smoke (n/8)` job runs.
 *
 *   node scripts/ci-e2e-shards.mjs --shard <n>/8
 *
 * prints one Playwright file filter per line (an anchored, regex-escaped path:
 * Playwright treats positional arguments as regular expressions over the file
 * path), for `pnpm test:e2e:ci "${files[@]}"`.
 *
 * WHY NOT `--shard`. Playwright's `--shard` splits the file list into
 * contiguous blocks of equal test COUNT. The specs here differ a hundredfold
 * in duration, and the alphabetical block holding copc-*, deviation-*,
 * document-text, document-chart-source-6629, entity-context-menu,
 * gaussian-browser-journey ... summed to ~13.8 min against a 13-minute cap
 * (merge-queue run 44788022622, shard 2: 27 passed, 0 failed, killed). The
 * other shards took 3-5 minutes. The cap stays; the split moves.
 *
 * HOW. FILES are the unit (a spec's tests share setup, and the project runs
 * one worker with fullyParallel off, so a file is never split across jobs).
 * They are packed longest-first onto the currently lightest shard (LPT) from
 * the measured durations in TIMINGS_S. A selected file with no timing is NOT
 * dropped: it is placed after the measured ones, each on whichever shard is
 * then lightest, at UNMEASURED_S, so a new spec runs somewhere and the table
 * is re-measured at leisure. A TIMINGS_S entry that no longer matches a
 * selected file makes the CLI refuse (as ci-node-test-shards.mjs does for a
 * stale pin): the file was renamed or dropped from testMatch, and the table
 * is no longer describing the suite.
 *
 * The selected set is the one the `viewer-e2e-ci` project selects: its
 * `testMatch` regex, read from playwright.config.ts, applied to every file
 * under testDir (./tests) the way Playwright does. The test pins that this
 * equals `playwright test --project=viewer-e2e-ci --list`'s files.
 *
 * Retry: scripts/ci-shard-retry.mjs reruns `--last-failed` with the same
 * filters, so the failed test ids resolve exactly as they did the first time.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';

export const SHARD_COUNT = 8;
export const PROJECT = 'viewer-e2e-ci';

/**
 * Seconds a file's tests take, as the MEDIAN over four successful `Viewer E2E
 * smoke` runs of the sum of its list-reporter durations (`✓ n [viewer-e2e-ci]
 * › file:line › title (12.3s)`). Source runs: 44794742144, 44787623046,
 * 44781819131, 44781800198 (all 8 shards each, every job `success`). Run
 * 44788022622 is left out: its shards 2 and 8 were killed, so their files'
 * logs are partial. geometry-backing-idb (#10868) is the sum of its five tests
 * in shard 2 of run 44788022622 (all passed before the kill). Setup around the tests (fixtures, server) is the same on
 * every shard and is not in these numbers.
 */
export const TIMINGS_S = Object.freeze(Object.fromEntries([
  ["tests/e2e/document-text.e2e.spec.ts", 279],
  ["tests/e2e/viewport-hud.e2e.spec.ts", 277],
  ["tests/e2e/validation-colors.e2e.spec.ts", 184],
  ["tests/e2e/command-palette-access.e2e.spec.ts", 172],
  ["tests/e2e/ortho-depth-nudge.e2e.spec.ts", 150],
  ["tests/e2e/saved-clash-reports-6947.e2e.spec.ts", 120],
  ["tests/e2e/command-palette-ux.e2e.spec.ts", 105],
  ["tests/e2e/entity-context-menu.e2e.spec.ts", 94],
  ["tests/e2e/rhino-import.e2e.spec.ts", 83],
  ["tests/e2e/cold-load-scene-snapshot.e2e.spec.ts", 66],
  ["tests/e2e/ortho-axis-views-9501.e2e.spec.ts", 64],
  ["tests/e2e/small-file-fast-path.e2e.spec.ts", 61],
  ["tests/e2e/geometry-backing-idb.e2e.spec.ts", 58],
  ["tests/e2e/content-storage.e2e.spec.ts", 59],
  ["tests/e2e/assistant-check-authoring.e2e.spec.ts", 54],
  ["tests/e2e/ids-bcf-export.e2e.spec.ts", 54],
  ["tests/e2e/model-reposition.e2e.spec.ts", 54],
  ["tests/e2e/command-palette-access-extension.e2e.spec.ts", 50],
  ["tests/e2e/ribbon-reachability-5874.e2e.spec.ts", 48],
  ["tests/e2e/gaussian-browser-journey.e2e.spec.ts", 47],
  ["tests/e2e/target-size-focus-5826.e2e.spec.ts", 47],
  ["tests/e2e/document-chart-source-6629.e2e.spec.ts", 41],
  ["tests/e2e/hierarchy-row-selection.e2e.spec.ts", 38],
  ["tests/e2e/visibility-scenarios.e2e.spec.ts", 37],
  ["tests/e2e/mobile-form-factor.e2e.spec.ts", 35],
  ["tests/e2e/viewer-smoke.e2e.spec.ts", 34],
  ["tests/e2e/update-edited-quantities.e2e.spec.ts", 33],
  ["tests/e2e/semantic-assist.e2e.spec.ts", 29],
  ["tests/e2e/reopen-held-pick.e2e.spec.ts", 28],
  ["tests/e2e/lists-value-rules.e2e.spec.ts", 28],
  ["tests/e2e/mobile-journey.e2e.spec.ts", 28],
  ["tests/e2e/flow-ai-review.e2e.spec.ts", 27],
  ["tests/e2e/section-measure-lasting-5893.e2e.spec.ts", 27],
  ["tests/e2e/assistant-artifacts.e2e.spec.ts", 27],
  ["tests/e2e/assistant-report-claims.e2e.spec.ts", 27],
  ["tests/e2e/rhino-export.e2e.spec.ts", 23],
  ["tests/e2e/copc-deviation.e2e.spec.ts", 21],
  ["tests/e2e/federation-control-triplet.e2e.spec.ts", 21],
  ["tests/e2e/section-extra-planes.e2e.spec.ts", 20],
  ["tests/e2e/swept-disk-inspection.e2e.spec.ts", 20],
  ["tests/e2e/selection-mask-depth.e2e.spec.ts", 19],
  ["tests/e2e/selective-clipping.e2e.spec.ts", 19],
  ["tests/e2e/visibility-empty-result.e2e.spec.ts", 19],
  ["tests/e2e/assistant-context.e2e.spec.ts", 19],
  ["tests/e2e/deviation-attribution.e2e.spec.ts", 18],
  ["tests/e2e/flow-assistant-context.e2e.spec.ts", 18],
  ["tests/e2e/semantic-linked-records.e2e.spec.ts", 18],
  ["tests/e2e/keyboard-dispatcher.e2e.spec.ts", 18],
  ["tests/e2e/visibility-chips.e2e.spec.ts", 18],
  ["tests/e2e/swept-disk-centreline.e2e.spec.ts", 17],
  ["tests/e2e/bulk-target-sources.e2e.spec.ts", 15],
  ["tests/e2e/hierarchy-names.e2e.spec.ts", 15],
  ["tests/e2e/symbolic-parse-outcomes.e2e.spec.ts", 14],
  ["tests/e2e/wheel-zoom-easing.e2e.spec.ts", 14],
  ["tests/e2e/swept-disk-source-snap.e2e.spec.ts", 13],
  ["tests/e2e/compare-impact-6921.e2e.spec.ts", 13],
  ["tests/e2e/bulk-filter-groups.e2e.spec.ts", 12],
  ["tests/e2e/review-workspace.e2e.spec.ts", 12],
  ["tests/e2e/document-block-jump-8227.e2e.spec.ts", 11],
  ["tests/e2e/panel-groups-5873.e2e.spec.ts", 11],
  ["tests/e2e/ribbon-labels.e2e.spec.ts", 11],
  ["tests/e2e/landxml-units-smoke.e2e.spec.ts", 11],
  ["tests/e2e/edge-line-continuity.e2e.spec.ts", 10],
  ["tests/e2e/sticky-overrides.e2e.spec.ts", 9],
  ["tests/e2e/projection-texture.e2e.spec.ts", 8],
  ["tests/e2e/retained-browser-never-fetch.e2e.spec.ts", 8],
  ["tests/e2e/omitted-type-records-8341.e2e.spec.ts", 8],
  ["tests/e2e/dialog-notices.e2e.spec.ts", 7],
  ["tests/e2e/command-palette-entry.e2e.spec.ts", 7],
  ["tests/e2e/ribbon-entity-actions.e2e.spec.ts", 6],
  ["tests/e2e/navigation-presets.e2e.spec.ts", 6],
  ["tests/e2e/copc-lod.e2e.spec.ts", 5],
  ["tests/e2e/lens-filter-groups.e2e.spec.ts", 5],
  ["tests/e2e/mobile-long-press.e2e.spec.ts", 4],
  ["tests/e2e/mobile-panels.e2e.spec.ts", 4],
  ["tests/e2e/ribbon-classic-migration.e2e.spec.ts", 3],
  ["tests/e2e/mobile-page-zoom.e2e.spec.ts", 2],
  ["tests/e2e/usd-export.e2e.spec.ts", 2],
  ["tests/e2e/laz-wasm.e2e.spec.ts", 1],
  ["tests/e2e/perspective-distance-depth.e2e.spec.ts", 0],
  ["tests/e2e/projection-depth.e2e.spec.ts", 0],
]));

/** Weight given to a selected file the table has not measured yet. */
export const UNMEASURED_S = 30;

export class ShardError extends Error {}

function fail(message) {
  throw new ShardError(message);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The `testMatch` of the `viewer-e2e-ci` project, as a RegExp, read from the
 * config source (the config is TypeScript and imports the Playwright runtime,
 * so it is not imported here).
 */
export function projectTestMatch(configSource) {
  const m = configSource.match(new RegExp(`name: '${PROJECT}',\\s*testMatch: /(.+)/[a-z]*,`));
  if (!m) fail(`playwright.config.ts has no '${PROJECT}' project with a regex testMatch; update scripts/ci-e2e-shards.mjs with it.`);
  return new RegExp(m[1]);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * Repo-relative paths of the files the project selects, sorted. Playwright
 * matches the regex against the absolute path of every file under testDir.
 */
export function selectedFiles(root = REPO_ROOT) {
  const re = projectTestMatch(readFileSync(join(root, 'playwright.config.ts'), 'utf8'));
  return walk(join(root, 'tests'), [])
    .filter((p) => re.test(p))
    .map((p) => relative(root, p).split('\\').join('/'))
    .sort();
}

/**
 * Pack `files` into `count` shards.
 * @param {string[]} files selected files
 * @param {number} count
 * @param {Record<string, number>} timings seconds per file
 * @returns {{ shards: string[][], loads: number[] }} files per shard (sorted), seconds per shard
 */
export function packShards(files, count = SHARD_COUNT, timings = TIMINGS_S) {
  const unique = new Set(files);
  if (unique.size !== files.length) fail('the file list contains duplicates');
  const stale = Object.keys(timings).filter((f) => !unique.has(f));
  if (stale.length > 0) {
    fail(
      `TIMINGS_S names ${stale.join(', ')}, which the ${PROJECT} project no longer selects. ` +
        'Fix TIMINGS_S in scripts/ci-e2e-shards.mjs; a stale entry means the table no longer describes the suite.',
    );
  }
  const measured = files.filter((f) => f in timings).sort((a, b) => timings[b] - timings[a] || a.localeCompare(b));
  const unmeasured = files.filter((f) => !(f in timings)).sort();
  const shards = Array.from({ length: count }, () => []);
  const loads = new Array(count).fill(0);
  for (const f of [...measured, ...unmeasured]) {
    let lightest = 0;
    for (let i = 1; i < count; i++) if (loads[i] < loads[lightest]) lightest = i;
    shards[lightest].push(f);
    loads[lightest] += timings[f] ?? UNMEASURED_S;
  }
  for (const s of shards) s.sort();
  return { shards, loads };
}

/**
 * A Playwright positional filter that selects exactly this file: the path,
 * escaped for a regex and anchored at the end (`rhino-export` must not also
 * select a longer name).
 */
export function fileFilter(file) {
  return `${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/**
 * @param {string} spec `n/8`
 * @returns {number} the 1-based shard
 */
export function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(spec ?? '');
  if (!m) fail(`expected --shard <n>/${SHARD_COUNT}, got ${JSON.stringify(spec)}`);
  const [shard, total] = [Number(m[1]), Number(m[2])];
  if (total !== SHARD_COUNT) fail(`the matrix runs ${total} shard(s) but this file packs for ${SHARD_COUNT}; change both together`);
  if (shard < 1 || shard > SHARD_COUNT) fail(`shard ${shard} is not between 1 and ${SHARD_COUNT}`);
  return shard;
}

/**
 * The Playwright filters for one shard of `n/8`.
 * @param {string} spec
 * @param {string} [root]
 * @returns {string[]}
 */
export function shardFilters(spec, root = REPO_ROOT) {
  const shard = parseShard(spec);
  const { shards } = packShards(selectedFiles(root));
  const mine = shards[shard - 1];
  if (mine.length === 0) fail(`shard ${shard}/${SHARD_COUNT} would run no spec file`);
  return mine.map(fileFilter);
}

function main(argv) {
  const at = argv.indexOf('--shard');
  try {
    for (const f of shardFilters(at >= 0 ? argv[at + 1] : undefined)) console.log(f);
  } catch (err) {
    if (!(err instanceof ShardError)) throw err;
    console.error(`::error::ci-e2e-shards: ${err.message}`);
    process.exit(1);
  }
}

if (isMainEntry(import.meta.url)) main(process.argv.slice(2));
