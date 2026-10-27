// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { compare, tsv } from './metrics.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

export async function runComparison({ engine, native, out }) {
  const nativeRows = tsv(await readFile(native, 'utf8'));
  const blessed = tsv(await readFile('tests/manifests/cli-retained-coverage.tsv', 'utf8'));
  const tolerance = JSON.parse(await readFile('tests/fixtures/cli-retained/tolerances.json', 'utf8')).nativeWasmVolumeRelative;
  if (tolerance !== 1e-9) throw new Error('Preregistered native/wasm tolerance changed');
  const scratch = await mkdtemp(join(tmpdir(), 'cli-retained-parity-'));
  const products = [];
  try {
    for (const [i, model] of [...new Set(blessed.map(p => p.model))].sort().entries()) {
      const directory = join(scratch, String(i)); await mkdir(directory);
      const child = spawnSync(process.execPath, ['scripts/retained-compare/child.mjs', resolve(engine), model, directory],
        { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`${model}: ${child.stderr}`);
      products.push(...JSON.parse(child.stdout));
    }
    const result = compare(nativeRows, products, blessed, tolerance);
    if (out) await writeFile(out, `${JSON.stringify({ ...result, products }, null, 2)}\n`);
    if (result.violations.length) throw new Error(JSON.stringify(result));
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--engine', '--native', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Expected --engine DIR --native products.tsv [--out result.json]');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.engine || !options.native) throw new Error('--engine and --native are required');
  console.log(JSON.stringify(await runComparison(options)));
}
