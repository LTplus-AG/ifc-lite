#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare two huge-geometry runner outputs (summary.json), paired by run name:
 *
 *   node scripts/perf/huge-geometry-compare.mjs BASE/summary.json NEXT/summary.json [--out FILE.md]
 *
 * Prints a markdown table of status and key metrics with ratios next/base.
 * Only compare results with the same evidence grade on the same host.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { markdownCompare } from './huge-geometry-report.mjs';

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
  if (positionals.length !== 2) { console.error('usage: huge-geometry-compare.mjs BASE/summary.json NEXT/summary.json [--out FILE.md]'); process.exit(2); }
  const [base, next] = positionals.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const warn = [];
  if (base.environment?.host !== next.environment?.host) warn.push(`hosts differ: ${base.environment?.host} vs ${next.environment?.host}`);
  if (base.environment?.evidence !== next.environment?.evidence) warn.push(`evidence grades differ: ${base.environment?.evidence} vs ${next.environment?.evidence}`);
  const md = `${warn.map((w) => `> WARNING: ${w}\n`).join('')}${markdownCompare(base.results, next.results,
    { baseLabel: base.environment?.label ?? 'base', nextLabel: next.environment?.label ?? 'next' })}`;
  if (values.out) writeFileSync(values.out, md);
  console.log(md);
}

if (isMainEntry(import.meta.url)) main();
