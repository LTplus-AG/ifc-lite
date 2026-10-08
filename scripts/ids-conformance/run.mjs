#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS conformance dashboard (IDS-125): run IDS engines over the vendored
 * buildingSMART IDS corpus and write the agreement matrix.
 *
 * Outputs:
 *   docs/guide/ids-conformance.json  machine-readable matrix (every case x engine)
 *   docs/guide/ids-conformance.md    the generated region, rendered from that JSON
 *
 * Usage (build first: `pnpm turbo build --filter=@ifc-lite/ids...`):
 *   node scripts/ids-conformance/run.mjs                       # ifc-lite + IDS 1.1 preview columns
 *   node scripts/ids-conformance/run.mjs --engine-config e.json [--engine-config f.json]
 *   node scripts/ids-conformance/run.mjs --out <dir> --limit 20 --no-doc
 *
 * The committed JSON is the record of a run over a fixed input (the corpus);
 * `lib/report.test.mjs` keeps the docs region in sync with it. Re-run this
 * script whenever an engine or the corpus changes.
 *
 * Not run in CI: it needs a built workspace and, for other engines, installs
 * outside the lockfile. Its library is tested in CI (the `.test.mjs` files under `lib/`), and
 * a test there pins the docs page to the committed JSON.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCorpus } from './lib/corpus.mjs';
import { buildMatrix } from './lib/matrix.mjs';
import { renderMarkdown, replaceRegion } from './lib/report.mjs';
import { createIfcLiteAdapter } from './lib/adapters/ifc-lite.mjs';
import { createCommandAdapter } from './lib/adapters/command.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORPUS = join(REPO, 'packages/ids/src/__corpus__/buildingsmart-ids');

/** @param {string[]} argv */
export function parseArgs(argv) {
  const opts = { engineConfigs: /** @type {string[]} */ ([]), out: join(REPO, 'docs/guide'), limit: 0, doc: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--engine-config') opts.engineConfigs.push(value());
    else if (arg === '--out') opts.out = value();
    else if (arg === '--limit') opts.limit = Number(value());
    else if (arg === '--no-doc') opts.doc = false;
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const all = discoverCorpus(CORPUS);
  const cases = opts.limit > 0 ? all.slice(0, opts.limit) : all;

  const adapters = [await createIfcLiteAdapter(), await createIfcLiteAdapter({ ids11: true })];
  for (const config of opts.engineConfigs) adapters.push(createCommandAdapter(config));

  const matrix = await buildMatrix(cases, adapters, {
    corpus: {
      name: 'buildingSMART IDS 1.0 test cases (vendored in packages/ids/src/__corpus__/buildingsmart-ids)',
      licence: 'CC BY-ND 4.0',
      source: 'https://github.com/buildingSMART/IDS',
    },
    onCase: (done, total) => {
      if (done % 25 === 0 || done === total) process.stderr.write(`  ${done}/${total} cases\n`);
    },
  });
  for (const adapter of adapters) await adapter.close?.();

  writeFileSync(join(opts.out, 'ids-conformance.json'), `${JSON.stringify(matrix, null, 2)}\n`);
  if (opts.doc) {
    const docPath = join(opts.out, 'ids-conformance.md');
    writeFileSync(docPath, replaceRegion(readFileSync(docPath, 'utf8'), renderMarkdown(matrix)));
  }
  for (const e of matrix.engines) {
    const t = matrix.summary[e.id].overall;
    console.log(`${e.name}: agree ${t.agree}, disagree ${t.disagree}, error ${t.error}, n/a ${t.na}`);
  }
  // Engines may leave worker threads running; the run is complete here.
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
