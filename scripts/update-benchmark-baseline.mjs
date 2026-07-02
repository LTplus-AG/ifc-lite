#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Merge the freshest viewer benchmark results into the committed baseline.
//
// The committed baseline is CI-recorded: numbers come from the Benchmark
// workflow's runner so the CI regression check diffs like-for-like. Local
// (much faster) machines record scratch baselines via BENCHMARK_BASELINE
// and never commit them.
//
// Usage:
//   node scripts/update-benchmark-baseline.mjs \
//     --environment "github-actions ubuntu-latest, headless Chrome + SwiftShader, production build"
//
// Only models present in tests/benchmark/benchmark-results/viewer-*.json are
// touched; other baseline entries are preserved as-is.
//
// BENCHMARK_BASELINE=<path> overrides the baseline file (same override the
// check script honors), e.g. for a local scratch baseline.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const args = process.argv.slice(2);

// Parsed lazily inside main() so a usage error prints the clean top-level
// message instead of a raw stack trace.
function parseEnvironment() {
  const eq = args.find((a) => a.startsWith('--environment='));
  if (eq) return eq.slice('--environment='.length);
  const idx = args.indexOf('--environment');
  if (idx !== -1) {
    const value = args[idx + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--environment requires a description argument');
    }
    return value;
  }
  return null;
}

const baselinePath = process.env.BENCHMARK_BASELINE
  ? resolve(process.env.BENCHMARK_BASELINE)
  : join(rootDir, 'tests/benchmark/baseline.json');
const resultsDir = join(rootDir, 'tests/benchmark/benchmark-results');

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function main() {
  const environment = parseEnvironment();
  if (!existsSync(resultsDir)) {
    throw new Error('No benchmark results directory found. Run `pnpm test:benchmark:viewer` first.');
  }
  const files = readdirSync(resultsDir).filter((name) => name.startsWith('viewer-') && name.endsWith('.json'));
  if (files.length === 0) {
    throw new Error('No viewer benchmark results found. Run `pnpm test:benchmark:viewer` first.');
  }

  const baseline = existsSync(baselinePath) ? loadJson(baselinePath) : {};

  const updated = [];
  for (const name of files) {
    const payload = loadJson(join(resultsDir, name));
    if (!payload.file || !payload.metrics) {
      throw new Error(`Result ${name} is missing "file" or "metrics"; refusing to write a partial baseline.`);
    }
    // Keep the entry's provenance note unless a new one is explicitly given.
    const keptEnvironment = environment ?? baseline[payload.file]?.environment ?? null;
    baseline[payload.file] = {
      timestamp: payload.timestamp,
      ...(keptEnvironment ? { environment: keptEnvironment } : {}),
      metrics: payload.metrics,
    };
    updated.push(payload.file);
  }

  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');

  console.log(`Baseline written to ${baselinePath}`);
  console.log(`Updated ${updated.length} entr${updated.length === 1 ? 'y' : 'ies'}:`);
  for (const file of updated) {
    console.log(`  - ${file}`);
  }
  const untouched = Object.keys(baseline).filter((k) => !updated.includes(k));
  if (untouched.length > 0) {
    console.log(`Preserved ${untouched.length} existing entr${untouched.length === 1 ? 'y' : 'ies'}: ${untouched.join(', ')}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
