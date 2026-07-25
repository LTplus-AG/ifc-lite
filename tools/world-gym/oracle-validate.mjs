#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Driver for the IfcOpenShell differential oracle (oracle_validate.py).
 *
 * Samples the corpus manifest deterministically (seed % every == 0, so the
 * sample is reproducible and mixes clean/corrupted at corpus proportions),
 * REGENERATES each sampled model from its seed (corpus runs with
 * --no-keep-files never wrote the bytes; determinism makes regeneration
 * exact - the driver verifies the regenerated sha256 against the manifest
 * before handing anything to the oracle), writes the .ifc files plus a
 * sample descriptor JSON, and invokes oracle_validate.py under a python
 * that has the PINNED engine (ifcopenshell==0.8.5, the same pin as
 * tools/ifcopenshell_reference/requirements.lock).
 *
 * Usage:
 *   node oracle-validate.mjs --manifest <manifest.jsonl> --python <venv/bin/python> \
 *     [--every 500] [--work-dir <dir>] [--out <report.json>]
 */

import { createReadStream } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { generateModel } from './generator.mjs';
import { getFlag, numberFlag } from './lib/flags.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = getFlag(args, '--manifest');
  const python = getFlag(args, '--python');
  if (!manifestPath || !python) {
    process.stderr.write('Usage: node oracle-validate.mjs --manifest <manifest.jsonl> --python <venv/bin/python> [--every 500] [--work-dir <dir>] [--out <report.json>]\n');
    process.exit(1);
  }
  const every = numberFlag(args, '--every', { def: 500, min: 1, integer: true });
  const workDir = resolve(getFlag(args, '--work-dir') ?? join(dirname(resolve(manifestPath)), 'oracle-sample'));
  const outPath = getFlag(args, '--out');

  await mkdir(workDir, { recursive: true });

  const models = [];
  let regenMismatches = 0;
  const rl = createInterface({ input: createReadStream(manifestPath, 'utf-8'), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    const line = JSON.parse(raw);
    if (typeof line.seed !== 'number' || line.seed % every !== 0) continue;

    const model = generateModel(line.seed, line.family, { forceCorrupt: line.corrupted });
    const sha = createHash('sha256').update(model.content, 'utf-8').digest('hex');
    if (sha !== line.sha256) {
      regenMismatches++;
      process.stderr.write(`WARNING: seed ${line.seed} regenerated sha differs from manifest - skipped\n`);
      continue;
    }
    const filePath = join(workDir, `${line.family}-${line.seed}.ifc`);
    await writeFile(filePath, model.content, 'utf-8');

    models.push({
      seed: line.seed,
      family: line.family,
      corrupted: line.corrupted,
      file: filePath,
      schema: 'IFC4',
      params: line.params,
      entityCountsByType: line.entityCountsByType,
      defects: line.defects ?? [],
      clashPairs: line.expected?.clashPairs ?? [],
      degenerateElements: line.expected?.degenerateElements ?? [],
      quantitiesExtracted: line.quantitiesExtracted,
      groundTruthTotals: line.groundTruth?.totals ?? {},
      openingCount: line.groundTruth?.openingCount ?? 0,
      // As-built (clamped) opening size; may differ from params.opening*.
      ...(line.groundTruth?.openingWidthUsed !== undefined
        ? { openingWidthUsed: line.groundTruth.openingWidthUsed, openingHeightUsed: line.groundTruth.openingHeightUsed }
        : {}),
    });
  }

  const samplePath = join(workDir, 'sample.json');
  await writeFile(samplePath, JSON.stringify({ models }, null, 2), 'utf-8');
  process.stderr.write(`Oracle sample: ${models.length} models (every ${every}th seed), ${models.filter((m) => m.corrupted).length} corrupted, regen sha mismatches: ${regenMismatches}\n`);

  const pyArgs = [join(HERE, 'oracle_validate.py'), '--sample', samplePath];
  if (outPath) pyArgs.push('--out', resolve(outPath));
  try {
    const { stdout } = await execFileAsync(python, pyArgs, { maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 });
    process.stdout.write(stdout);
  } catch (err) {
    // Non-zero exit = oracle found disagreements; still print its report.
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
