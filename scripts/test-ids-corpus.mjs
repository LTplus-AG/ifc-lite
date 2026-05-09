#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS validation parity harness — runs the buildingSMART/IDS official
 * implementer test corpus through our parser + validator and compares
 * the spec status to the filename prefix.
 *
 * Each fixture pair is named with one of three prefixes:
 *   pass-*    → expect IDSSpecificationResult.status === 'pass'
 *   fail-*    → expect IDSSpecificationResult.status === 'fail'
 *   invalid-* → expect IDSSpecificationResult.status === 'not_applicable'
 *               (i.e. no applicability matched, or the IDS itself
 *               wouldn't validate against the input)
 *
 * Reports a parity rate per category + overall, and lists divergences.
 *
 * Run the script directly with `node` so we avoid `tsx`'s workspace-
 * source resolution (which conflicts with our compiled-dist imports).
 *
 * Usage:
 *   node scripts/test-ids-corpus.mjs                  # full corpus
 *   node scripts/test-ids-corpus.mjs --category=entity
 *   node scripts/test-ids-corpus.mjs --verbose        # log every fixture
 *   node scripts/test-ids-corpus.mjs --limit=20       # first 20 per category
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseIDS, validateIDS } from '../packages/ids/dist/index.js';
import { IfcParser } from '../packages/parser/dist/index.js';
import { createDataAccessor } from '../packages/ids/dist/bridge/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(
  __dirname,
  '../packages/ids/src/__corpus__/buildingsmart-ids'
);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const categoryArg = args.find((a) => a.startsWith('--category='))?.split('=')[1];
const limitArg = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '0');

// ---------------------------------------------------------------------------
// Discovery + runner
// ---------------------------------------------------------------------------

function expectedFromPrefix(filename) {
  if (filename.startsWith('pass-')) return 'pass';
  if (filename.startsWith('fail-')) return 'fail';
  // `invalid-` per buildingSMART means the IDS+IFC pair, when run
  // through ifctester, results in spec.status=fail — the IDS makes
  // sense but the IFC cannot satisfy it (e.g. uppercase requirement
  // matched against a PascalCase value, subclass that isn't the
  // requested class, etc.).
  if (filename.startsWith('invalid-')) return 'fail';
  return null;
}

function discover() {
  const out = [];
  if (!fs.existsSync(CORPUS_ROOT)) {
    throw new Error(`Corpus directory not found: ${CORPUS_ROOT}`);
  }
  for (const category of fs.readdirSync(CORPUS_ROOT)) {
    if (categoryArg && category !== categoryArg) continue;
    const dir = path.join(CORPUS_ROOT, category);
    if (!fs.statSync(dir).isDirectory()) continue;
    const idsFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.ids')).sort();
    let count = 0;
    for (const ids of idsFiles) {
      const base = ids.slice(0, -'.ids'.length);
      const expected = expectedFromPrefix(base);
      if (!expected) continue;
      const ifcPath = path.join(dir, `${base}.ifc`);
      if (!fs.existsSync(ifcPath)) continue;
      out.push({
        category,
        name: base,
        expected,
        idsPath: path.join(dir, ids),
        ifcPath,
      });
      count++;
      if (limitArg > 0 && count >= limitArg) break;
    }
  }
  return out;
}

async function runFixture(pair) {
  let actualStatus;
  try {
    const xml = fs.readFileSync(pair.idsPath, 'utf8');
    const ifcBuf = fs.readFileSync(pair.ifcPath);
    const ifcArrayBuf = ifcBuf.buffer.slice(
      ifcBuf.byteOffset,
      ifcBuf.byteOffset + ifcBuf.byteLength
    );

    const ids = parseIDS(xml);
    const parser = new IfcParser();
    const dataStore = await parser.parseColumnar(ifcArrayBuf, {});

    const accessor = createDataAccessor(dataStore);
    const report = await validateIDS(
      ids,
      accessor,
      {
        modelId: pair.name,
        // The parser detects FILE_SCHEMA from the IFC header; falling
        // back to IFC4 keeps things working when the header is absent.
        schemaVersion: dataStore.schemaVersion || 'IFC4',
        entityCount: dataStore.entityIndex?.byId?.size ?? 0,
      },
      {}
    );

    if (report.specificationResults.length === 0) {
      actualStatus = 'not_applicable';
    } else {
      // Each fixture targets exactly one spec; pick the first.
      actualStatus = report.specificationResults[0].status;
    }
  } catch (err) {
    return {
      pair,
      outcome: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    pair,
    outcome: actualStatus === pair.expected ? 'match' : 'mismatch',
    actualStatus,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printSummary(results) {
  const byCategory = new Map();
  for (const r of results) {
    let row = byCategory.get(r.pair.category);
    if (!row) {
      row = { match: 0, mismatch: 0, error: 0, total: 0 };
      byCategory.set(r.pair.category, row);
    }
    row.total++;
    if (r.outcome === 'match') row.match++;
    else if (r.outcome === 'mismatch') row.mismatch++;
    else row.error++;
  }
  console.log('\nbuildingSMART/IDS corpus parity report');
  console.log('======================================');
  console.log(
    'category'.padEnd(16),
    'match'.padStart(7),
    'mismatch'.padStart(10),
    'error'.padStart(7),
    'total'.padStart(7),
    'parity'.padStart(8)
  );
  let allMatch = 0;
  let allTotal = 0;
  for (const [cat, row] of [...byCategory.entries()].sort()) {
    const parity = ((row.match / row.total) * 100).toFixed(1) + '%';
    console.log(
      cat.padEnd(16),
      String(row.match).padStart(7),
      String(row.mismatch).padStart(10),
      String(row.error).padStart(7),
      String(row.total).padStart(7),
      parity.padStart(8)
    );
    allMatch += row.match;
    allTotal += row.total;
  }
  console.log('-'.repeat(60));
  const overall = ((allMatch / allTotal) * 100).toFixed(1) + '%';
  console.log(
    'overall'.padEnd(16),
    String(allMatch).padStart(7),
    ''.padStart(10),
    ''.padStart(7),
    String(allTotal).padStart(7),
    overall.padStart(8)
  );
}

function printDivergences(results) {
  const diverged = results.filter(
    (r) => r.outcome === 'mismatch' || r.outcome === 'error'
  );
  if (diverged.length === 0) {
    console.log('\nNo divergences. Full upstream parity. ✓');
    return;
  }
  console.log(`\nDivergences (${diverged.length}):`);
  for (const r of diverged) {
    if (r.outcome === 'mismatch') {
      console.log(
        `  ${r.pair.category}/${r.pair.name}: expected=${r.pair.expected} actual=${r.actualStatus}`
      );
    } else {
      console.log(
        `  ${r.pair.category}/${r.pair.name}: ERROR ${r.errorMessage}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const fixtures = discover();
  console.log(
    `Discovered ${fixtures.length} fixture pair(s)${
      categoryArg ? ` in category "${categoryArg}"` : ''
    }${limitArg > 0 ? ` (limited to ${limitArg} per category)` : ''}.`
  );
  const results = [];
  let i = 0;
  for (const pair of fixtures) {
    i++;
    if (verbose) {
      process.stdout.write(`[${i}/${fixtures.length}] ${pair.category}/${pair.name}…`);
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await runFixture(pair);
    results.push(r);
    if (verbose) {
      const tag = r.outcome === 'match' ? '✓' : r.outcome === 'mismatch' ? '✗' : '!';
      console.log(` ${tag} ${r.actualStatus ?? r.errorMessage ?? ''}`);
    } else if (i % 25 === 0) {
      process.stdout.write(`  ${i}/${fixtures.length}\r`);
    }
  }
  if (!verbose) console.log();
  printSummary(results);
  printDivergences(results);
  const diverged = results.filter((r) => r.outcome !== 'match').length;
  process.exit(diverged === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
