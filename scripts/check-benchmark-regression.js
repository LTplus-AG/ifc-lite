#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Compare the freshest viewer benchmark results against the committed
// baseline and report per-metric deltas.
//
// Usage:
//   node scripts/check-benchmark-regression.js                 # exit 1 on regression
//   node scripts/check-benchmark-regression.js --advisory      # threshold regressions are
//                                                              # reported but exit 0; hard
//                                                              # errors (no results, missing
//                                                              # baseline file) still exit 1
//   node scripts/check-benchmark-regression.js --markdown out.md
//                                                              # also write a GitHub-flavored
//                                                              # markdown report (PR comment /
//                                                              # step summary)
//
// BENCHMARK_BASELINE=<path> overrides the baseline file, e.g. to diff against
// a locally recorded scratch baseline instead of the committed (CI-recorded)
// one.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const args = process.argv.slice(2);
const advisory = args.includes('--advisory');

// Parsed lazily inside main() so a usage error prints the clean top-level
// message instead of a raw stack trace.
function parseMarkdownPath() {
  const eq = args.find((a) => a.startsWith('--markdown='));
  if (eq) return resolve(eq.slice('--markdown='.length));
  const idx = args.indexOf('--markdown');
  if (idx !== -1) {
    const value = args[idx + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--markdown requires a file path argument');
    }
    return resolve(value);
  }
  return null;
}

const baselinePath = process.env.BENCHMARK_BASELINE
  ? resolve(process.env.BENCHMARK_BASELINE)
  : join(rootDir, 'tests/benchmark/baseline.json');
const resultsDir = join(rootDir, 'tests/benchmark/benchmark-results');

const thresholds = {
  firstBatchWaitMs: 50,
  firstVisibleGeometryMs: 50,
  streamCompleteMs: 50,
  spatialReadyMs: 50,
  metadataCompleteMs: 50,
  totalWallClockMs: 50,
};

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function percentIncrease(current, baseline) {
  if (typeof current !== 'number' || typeof baseline !== 'number' || baseline <= 0) {
    return null;
  }
  return ((current - baseline) / baseline) * 100;
}

// The CI job diffs like-for-like only when the baseline was itself recorded on
// the CI runner. A locally recorded baseline (fast Apple-Silicon, real GPU, an
// older metric era) makes every SwiftShader CI run look like a huge regression —
// which is exactly the false alarm this check is meant to avoid. Flag a baseline
// entry that carries no CI environment tag so the mismatch is visible, not silent.
function looksCiRecorded(environment) {
  return typeof environment === 'string' && /github-actions|swiftshader|ubuntu-latest|\bci\b/i.test(environment);
}

function formatMs(value) {
  if (typeof value !== 'number') return 'N/A';
  return `${value.toFixed(0)}ms`;
}

function formatPct(value) {
  if (value === null) return 'N/A';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function loadResults() {
  if (!existsSync(resultsDir)) {
    throw new Error('No benchmark results directory found. Run `pnpm test:benchmark:viewer` first.');
  }

  const files = readdirSync(resultsDir).filter((name) => name.startsWith('viewer-') && name.endsWith('.json'));
  if (files.length === 0) {
    throw new Error('No viewer benchmark results found. Run `pnpm test:benchmark:viewer` first.');
  }

  return files.map((name) => {
    const path = join(resultsDir, name);
    const payload = loadJson(path);
    return { name, path, payload };
  });
}

function compareResults() {
  if (!existsSync(baselinePath)) {
    throw new Error('No baseline available. Create one with `pnpm benchmark:baseline`.');
  }

  const baseline = loadJson(baselinePath);
  const results = loadResults();

  const models = [];
  for (const { payload, name } of results) {
    const fileName = payload.file;
    const metrics = payload.metrics || {};
    const baselineEntry = baseline[fileName];

    const model = {
      fileName,
      source: name,
      baselineTimestamp: baselineEntry?.timestamp ?? null,
      baselineEnvironment: baselineEntry?.environment ?? null,
      missingBaseline: !baselineEntry?.metrics,
      baselineLikelyLocal: !!baselineEntry?.metrics && !looksCiRecorded(baselineEntry?.environment),
      rows: [],
    };

    if (!model.missingBaseline) {
      for (const metricName of Object.keys(thresholds)) {
        const threshold = thresholds[metricName];
        const currentValue = metrics[metricName];
        const baselineValue = baselineEntry.metrics[metricName];
        const increasePct = percentIncrease(currentValue, baselineValue);
        model.rows.push({
          metricName,
          currentValue,
          baselineValue,
          increasePct,
          threshold,
          regressed: increasePct !== null && increasePct > threshold,
        });
      }
    }
    models.push(model);
  }

  return { models };
}

function printConsoleReport(models) {
  console.log('Benchmark regression check');
  console.log('='.repeat(80));

  for (const model of models) {
    console.log(`\n${model.fileName}`);
    console.log(`  Result source: ${model.source}`);

    if (model.missingBaseline) {
      console.log('  ⚠ No baseline entry for this model');
      continue;
    }
    if (model.baselineEnvironment) {
      console.log(`  Baseline environment: ${model.baselineEnvironment}`);
    }
    if (model.baselineLikelyLocal) {
      console.warn(
        '  ⚠ Baseline is not CI-recorded (no CI environment tag) — deltas below may reflect a ' +
          'machine/metric-era mismatch, not a code change. Refresh via the Benchmark workflow ' +
          '(record_baseline); see tests/benchmark/README.md.'
      );
    }

    for (const row of model.rows) {
      const line = `  - ${row.metricName}: ${formatMs(row.currentValue)} vs ${formatMs(row.baselineValue)} (${formatPct(row.increasePct)})`;
      if (row.regressed) {
        console.log(`${line}  ❌ threshold +${row.threshold}%`);
      } else {
        console.log(`${line}  ✅`);
      }
    }
  }
}

function buildMarkdownReport(models, regressions) {
  const lines = [];
  lines.push('<!-- viewer-benchmark-report -->');
  lines.push('## Viewer benchmark');
  lines.push('');
  if (regressions.length > 0) {
    lines.push(
      `⚠ **${regressions.length} metric(s) exceeded the regression threshold**` +
        (advisory ? ' (advisory only, not blocking).' : '.')
    );
  } else {
    lines.push('✅ No threshold regressions detected.');
  }
  lines.push('');

  for (const model of models) {
    lines.push(`### ${model.fileName}`);
    if (model.missingBaseline) {
      lines.push('');
      lines.push('⚠ No baseline entry for this model.');
      lines.push('');
      continue;
    }
    const baselineNote = [
      model.baselineTimestamp ? `recorded ${model.baselineTimestamp}` : null,
      model.baselineEnvironment ? `on ${model.baselineEnvironment}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    if (baselineNote) {
      lines.push('');
      lines.push(`Baseline ${baselineNote}.`);
    }
    if (model.baselineLikelyLocal) {
      lines.push('');
      lines.push(
        '> ⚠ This baseline is not CI-recorded (no CI environment tag), so the deltas below may reflect a ' +
          'machine/metric-era mismatch rather than a code change. Refresh it via the Benchmark workflow ' +
          '(`record_baseline`).'
      );
    }
    lines.push('');
    lines.push('| Metric | Current | Baseline | Delta | Threshold | Status |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of model.rows) {
      const status = row.regressed ? '❌' : '✅';
      lines.push(
        `| ${row.metricName} | ${formatMs(row.currentValue)} | ${formatMs(row.baselineValue)} | ` +
          `${formatPct(row.increasePct)} | +${row.threshold}% | ${status} |`
      );
    }
    lines.push('');
  }

  lines.push(
    'Refresh the baseline from a CI run: dispatch the Benchmark workflow with ' +
      '`record_baseline`, download the `benchmark-baseline` artifact, and commit ' +
      '`baseline.json` (see tests/benchmark/README.md).'
  );
  lines.push('');
  return lines.join('\n');
}

function main() {
  const markdownPath = parseMarkdownPath();
  const { models } = compareResults();
  const regressions = models.flatMap((m) =>
    m.rows.filter((r) => r.regressed).map((r) => ({ fileName: m.fileName, ...r }))
  );
  const missingBaseline = models.filter((m) => m.missingBaseline).map((m) => m.fileName);

  printConsoleReport(models);

  console.log('\n' + '='.repeat(80));
  if (missingBaseline.length > 0) {
    console.log(`Missing baseline entries: ${missingBaseline.length}`);
    for (const fileName of missingBaseline) {
      console.log(`  - ${fileName}`);
    }
  }

  if (markdownPath) {
    writeFileSync(markdownPath, buildMarkdownReport(models, regressions));
    console.log(`Markdown report written to ${markdownPath}`);
  }

  if (regressions.length > 0) {
    console.error(`\nFound ${regressions.length} regression(s):`);
    for (const reg of regressions) {
      console.error(
        `  - ${reg.fileName} :: ${reg.metricName} increased by ${reg.increasePct.toFixed(1)}% ` +
          `(${reg.currentValue}ms vs ${reg.baselineValue}ms, allowed +${reg.threshold}%)`
      );
    }
    if (advisory) {
      console.log('\nAdvisory mode: regressions reported but not failing the run.');
      return;
    }
    process.exit(1);
  }

  console.log('\nNo threshold regressions detected.');
  if (missingBaseline.length > 0) {
    console.log('Some models are missing baseline entries (warning only).');
  }
}

try {
  main();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
