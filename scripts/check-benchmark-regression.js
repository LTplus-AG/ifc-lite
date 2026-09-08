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
          // A metric that stops being EMITTED gives `percentIncrease` a
          // non-number and therefore `null`, which `regressed` reads as "fine"
          // (#3200, finding 8). It is not fine — it is an unmeasured metric,
          // and rendering it with the same ✅ as a measured pass silently
          // retires it. Renaming one harness field is enough to do that to a
          // single metric while the other five keep working.
          unmeasured: increasePct === null,
          // LOST is the narrower, actionable half: the BASELINE had a number
          // and this run does not. Absent on both sides is ordinary — two of
          // the four committed baseline entries carry only 2 of the 6 metrics,
          // so failing on plain `unmeasured` would hard-fail the lane the
          // moment either model entered VIEWER_BENCHMARK_FILES. Only `lost`
          // gates the exit; `unmeasured` still controls the ⚠ in the report.
          lost: typeof baselineValue === 'number' && typeof currentValue !== 'number',
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
      } else if (row.unmeasured) {
        console.log(`${line}  ⚠️  NOT MEASURED (no comparable number on one side)`);
      } else {
        console.log(`${line}  ✅`);
      }
    }
  }
}

/** Metrics whose delta could not be computed at all — see `unmeasured`. */
function unmeasuredCount(models) {
  return models.reduce((n, m) => n + m.rows.filter((r) => r.unmeasured).length, 0);
}

/** Metrics the BASELINE had and this run does not — see `lost`. */
function lostMetrics(models) {
  return models.flatMap((m) =>
    m.rows.filter((r) => r.lost).map((r) => `${m.fileName} :: ${r.metricName}`)
  );
}

function buildMarkdownReport(models, regressions, harnessFaults = []) {
  const unmeasured = unmeasuredCount(models);
  const uncompared = models.filter((m) => m.missingBaseline).length;
  const lines = [];
  lines.push('<!-- viewer-benchmark-report -->');
  lines.push('## Viewer benchmark');
  lines.push('');
  // THE MARKDOWN IS THE PRIMARY ARTEFACT: `benchmark.yml` publishes it to the
  // step summary and the sticky PR comment, and that is what a human actually
  // reads. An earlier version of this change refused a clean verdict on the
  // CONSOLE only, so on a renamed fixture the console said "no verdict" while
  // the PR comment said `✅ No threshold regressions detected.` — with no rows,
  // `unmeasured` is 0 and that headline is trivially true and entirely
  // misleading. Fixing one and not the other reproduces the mixed signal this
  // change exists to remove, in the louder of the two channels.
  if (harnessFaults.length > 0) {
    lines.push(
      `❌ **No verdict: the benchmark did not run.** ${harnessFaults.length} harness fault(s):`
    );
    lines.push('');
    for (const f of harnessFaults) {
      lines.push(`- ${f.split('\n')[0].trim()}`);
    }
    lines.push('');
    lines.push(
      'Threshold results below (if any) are reported for completeness and are NOT a pass.'
    );
  } else if (regressions.length > 0) {
    lines.push(
      `⚠ **${regressions.length} metric(s) exceeded the regression threshold**` +
        (advisory ? ' (advisory only, not blocking).' : '.')
    );
  } else if (uncompared > 0) {
    // The `comparable.length === 0` harness fault above only fires when EVERY
    // model missed its baseline. `VIEWER_BENCHMARK_FILES` lists TWO models, so
    // renaming ONE fixture — the likelier accident — left this headline saying
    // `✅ No threshold regressions detected.` over a model that was never
    // compared at all. Some models were compared, so there IS a partial verdict
    // and this stays non-blocking; it just must not read as a clean bill of
    // health (#3200).
    lines.push(
      `⚠ **No threshold regressions — but ${uncompared} of ${models.length} model(s) had NO ` +
        'baseline entry** and were never compared, so this is not a clean bill of health.'
    );
  } else if (unmeasured > 0) {
    lines.push(
      `⚠ **No threshold regressions — but ${unmeasured} metric(s) were NOT MEASURED** ` +
        '(no comparable number on one side), so this is not a clean bill of health.'
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
      const status = row.regressed ? '❌' : row.unmeasured ? '⚠️ not measured' : '✅';
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

  // Harness faults are computed and reported BEFORE the regression branch, and
  // are NOT covered by `--advisory` (#3200). An earlier version of this put them
  // after, where the advisory `return` on any threshold regression skipped them
  // entirely -- so the one run most likely to have a broken harness was the one
  // that never checked. Thresholds are +50% on a shared runner, so that branch
  // is taken often.
  //
  // `--advisory` exists so a NOISY benchmark cannot block a PR. A benchmark that
  // did not RUN is a different thing, and has no verdict to soften.
  const unmeasured = unmeasuredCount(models);
  const lost = lostMetrics(models);
  const comparable = models.filter((m) => !m.missingBaseline);
  const harnessFaults = [];

  if (models.length > 0 && comparable.length === 0) {
    harnessFaults.push(
      `${models.length} model(s) ran and NOT ONE had a baseline entry to compare against.\n` +
        "   Baselines are keyed on the result payload's `file` name, so a renamed fixture misses\n" +
        '   every lookup and this check then reports a clean run having compared nothing.'
    );
  }
  if (lost.length > 0) {
    harnessFaults.push(
      `${lost.length} metric(s) the BASELINE had are not produced by this run:\n` +
        lost.map((l) => `     - ${l}`).join('\n') +
        '\n   A metric that stops being emitted is not a passing metric. Check the harness field\n' +
        '   names before reading anything else as green.'
    );
  }

  console.log('\n' + '='.repeat(80));
  if (missingBaseline.length > 0) {
    console.log(`Missing baseline entries: ${missingBaseline.length}`);
    for (const fileName of missingBaseline) {
      console.log(`  - ${fileName}`);
    }
  }

  // Written BEFORE any exit: on a harness fault this report IS the diagnosis.
  if (markdownPath) {
    writeFileSync(markdownPath, buildMarkdownReport(models, regressions, harnessFaults));
    console.log(`Markdown report written to ${markdownPath}`);
  }

  /** Print every harness fault and exit 1. Never softened by --advisory. */
  function reportHarnessFaults() {
    if (harnessFaults.length === 0) return;
    for (const f of harnessFaults) console.error(`\n\u274c ${f}`);
    console.error(
      '\n   Not softened by --advisory: these say the check did not run, not that it is slow.'
    );
    process.exit(1);
  }

  if (regressions.length > 0) {
    console.error(`\nFound ${regressions.length} regression(s):`);
    for (const reg of regressions) {
      console.error(
        `  - ${reg.fileName} :: ${reg.metricName} increased by ${reg.increasePct.toFixed(1)}% ` +
          `(${reg.currentValue}ms vs ${reg.baselineValue}ms, allowed +${reg.threshold}%)`
      );
    }
    if (!advisory) {
      // Harness faults FIRST, then exit. They used to be printed after this
      // `process.exit(1)`, so a run with both a regression and a lost metric
      // printed only "Found 1 regression(s)" on the console -- the ❌ lines and
      // "Not softened by --advisory" went to the markdown and nowhere else. CI
      // always passes --advisory so the lane never saw it; a local
      // `pnpm benchmark:check` did. Reporting the SOFTER of two problems and
      // hiding the harder one is the shape this gate exists to remove.
      reportHarnessFaults();
      process.exit(1);
    }
    console.log('\nAdvisory mode: regressions reported but not failing the run.');
  } else if (harnessFaults.length > 0) {
    // Say NOTHING clean here. Printing "No threshold regressions detected."
    // above an ❌ is the mixed signal this gate exists to remove: with no
    // baseline matched there are no rows, so there are trivially no
    // regressions, and that sentence is true and useless. A reader skimming
    // for a verdict finds the reassuring one first.
    console.log('\nNo verdict: see the harness fault(s) below.');
  } else if (missingBaseline.length > 0) {
    // Same reason as the markdown branch: a PARTIAL miss is not a clean run.
    console.log(
      `\nNo threshold regressions among the ${comparable.length} model(s) that HAD a baseline — ` +
        `${missingBaseline.length} of ${models.length} were never compared.`
    );
  } else if (unmeasured > 0) {
    console.log('\nNo threshold regressions among the metrics that WERE measured.');
  } else {
    console.log('\nNo threshold regressions detected.');
  }

  reportHarnessFaults();


}

try {
  main();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
