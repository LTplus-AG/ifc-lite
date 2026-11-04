#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * UI drift ratchet (#8802): an objective hill-climb score for the viewer overhaul,
 * relative to the existing index.css @theme token system. Counts palette-class,
 * bw-class, hex-literal, arbitrary-value and native-control occurrences.
 * components/ui/ is excluded on purpose: primitives may own raw design values.
 * The baseline stores totals only so parallel migration PRs avoid per-file conflicts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { scanTree } from './lib/ui-drift.mjs';

function run() {
  const { values } = parseArgs({ options: {
    root: { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '..') },
    report: { type: 'boolean' }, json: { type: 'boolean' },
    update: { type: 'boolean' }, 'allow-increase': { type: 'boolean' },
  } });
  if (values.update && (values.report || values.json)) throw new Error('--update cannot be combined with --report or --json');
  const root = resolve(values.root);
  const { totals, files } = scanTree(root);
  const topFiles = Object.fromEntries(Object.keys(totals).map((category) => [category,
    Object.entries(files).map(([path, counts]) => ({ path, count: counts[category] }))
      .filter(({ count }) => count > 0).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, 20),
  ]));
  const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  const printFiles = (category, limit) => {
    for (const { path, count } of topFiles[category].slice(0, limit)) console.log(`  ${count}\t${path}`);
  };
  if (values.json) {
    console.log(JSON.stringify({ totals, grandTotal, topFiles }, null, 2));
    return 0;
  }
  if (values.report) {
    for (const [category, count] of Object.entries(totals)) console.log(`${category}: ${count}`);
    console.log(`Grand total: ${grandTotal}`);
    for (const category of Object.keys(totals)) {
      console.log(`\n${category} — top 20 files:`);
      printFiles(category, 20);
    }
    return 0;
  }
  const baselinePath = resolve(root, 'scripts/ui-drift-baseline.json');
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  if (!baseline && !values.update) throw new Error('Missing UI drift baseline; generate it with --update');
  if (baseline && (baseline.version !== 1 || !baseline.totals || Object.values(baseline.totals)
    .some((count) => !Number.isSafeInteger(count) || count < 0))) throw new Error('Invalid UI drift baseline (expected version 1 and nonnegative integer totals)');
  const categories = new Set([...Object.keys(totals), ...Object.keys(baseline?.totals ?? {})]);
  const override = values.update && values['allow-increase'];
  let increased = false;
  let mismatched = false;
  for (const category of categories) {
    const previous = baseline?.totals[category];
    const current = totals[category];
    if (baseline && (previous === undefined || current === undefined)) {
      // Only a scanner change adds or drops a category; rewriting the baseline is then deliberate.
      if (override) continue;
      console.error(`Category mismatch: ${category} missing from ${previous === undefined ? 'baseline' : 'tree'}`);
      mismatched = true;
    } else if (previous !== undefined && current > previous && !(values.update && values['allow-increase'])) {
      console.error(`${category}: baseline ${previous}, current ${current}, delta +${current - previous}`);
      printFiles(category, 15);
      increased = true;
    } else if (!values.update && current < previous) {
      console.log(`drift went down by ${previous - current} in ${category}; lock it in with \`pnpm ui-drift:update\``);
    }
  }
  if (mismatched) {
    console.error('The scanner\'s categories and the baseline\'s differ, which only a change to scripts/lib/ui-drift.mjs causes. Regenerate the baseline with node scripts/check-ui-drift.mjs --update --allow-increase in that same change.');
  }
  if (increased) {
    console.error('Use design tokens/primitives (apps/viewer/src/index.css @theme tokens, components/ui/*), or for a justified increase run node scripts/check-ui-drift.mjs --update --allow-increase and explain in the PR.');
  }
  if (mismatched || increased) return 1;
  if (values.update) {
    writeFileSync(baselinePath, `${JSON.stringify({ version: 1, totals }, null, 2)}\n`);
    console.log('Updated UI drift baseline.');
  } else console.log('UI style drift ratchet passed.');
  return 0;
}

try {
  process.exitCode = run();
} catch (error) {
  console.error(`UI drift: ${error.message}`);
  process.exitCode = 1;
}
