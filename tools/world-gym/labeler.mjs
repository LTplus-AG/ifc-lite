#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World Gym deterministic labeler (M2 midterm, B1.2 -> Phase 2 debt closure).
 *
 * Label sources (three, categorically different):
 *
 * 1. Generation-parameter ground truth (free, exact, zero re-derivation
 *    risk): entity counts by type from IfcCreator's own `result.entities`;
 *    storey count and every quantity from the family module's `build()`
 *    return value. Plus, for corrupted models, the planted-defect records
 *    and the derived expectations (`model.defects` / `model.expected`) -
 *    written by the corruption layer, never by this labeler, so the two
 *    cannot be circular.
 *
 * 2. Checks that run the real pipeline on the serialized bytes: schema
 *    validity, clash detection, and independent quantity re-extraction.
 *    Since v2 these run IN-PROCESS (lib/checks.mjs) using the exact same
 *    functions the `ifc-lite validate` / `ifc-lite clash` commands call,
 *    with one warm GeometryProcessor per process. The v1 subprocess path
 *    (two fresh `node dist/index.js` launches per model, ~1.4s median) is
 *    retained behind `engine: 'subprocess'` for A/B measurement and as a
 *    fallback; it produces the same verdict fields. The v1 stdout-JSON
 *    workaround (`extractTrailingJson`, see below) only applies to the
 *    subprocess path.
 *
 * 3. Agreement: expected-vs-detected comparison per model - does the
 *    pipeline actually see what the corruption layer planted (and see
 *    nothing on clean models)? This is the per-model unit of the
 *    defect-detection reward channel.
 *
 * GAP (documented, not fixed here - outside tools/world-gym's own path):
 * `ifc-lite clash --json` writes non-JSON diagnostic lines to stdout (from
 * the geometry pipeline's console.log calls). The subprocess path works
 * around it via `extractTrailingJson()`; the in-process path routes the
 * same console noise to stderr instead (lib/checks.mjs withQuietConsole).
 * Should still be fixed upstream in packages/cli or packages/geometry.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { generateModel } from './generator.mjs';
import {
  parseStore, schemaCheckInProcess, clashCheckInProcess,
  extractQuantityTotals, findExpressIdsByNamePrefix, initChecks,
} from './lib/checks.mjs';
import { getFlag, numberFlag, seedFlag } from './lib/flags.mjs';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI_ENTRY = join(HERE, '..', '..', 'packages', 'cli', 'dist', 'index.js');

/** Extract the trailing JSON object from CLI stdout that may be preceded by unrelated diagnostic lines (see file-level gap note). */
function extractTrailingJson(stdout) {
  const lines = stdout.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === '{');
  if (startIdx === -1) {
    throw new Error(`No JSON object found in CLI stdout:\n${stdout.slice(0, 500)}`);
  }
  return JSON.parse(lines.slice(startIdx).join('\n'));
}

async function runCli(args, { timeoutMs = 60_000 } = {}) {
  const { stdout } = await execFileAsync(process.execPath, [CLI_ENTRY, ...args], {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return extractTrailingJson(stdout);
}

/** Schema/structural validity - v1 subprocess path (`ifc-lite validate --json`). */
async function schemaCheckSubprocess(filePath) {
  try {
    const v = await runCli(['validate', filePath, '--json']);
    return {
      ok: true,
      valid: v.valid,
      errors: v.errors,
      warnings: v.warnings,
      schema: v.schema,
    };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
}

/** Clash count - v1 subprocess path (`ifc-lite clash --matrix --json`). NOTE: matrix-only, so blind to footing self-clashes (see lib/checks.mjs). */
async function clashCheckSubprocess(filePath) {
  try {
    const c = await runCli(['clash', filePath, '--matrix', '--json'], { timeoutMs: 120_000 });
    return {
      ok: true,
      total: c.summary.total,
      bySeverity: c.summary.bySeverity,
    };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
}

function entityCountsByType(entities) {
  const counts = {};
  for (const e of entities) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Expected-vs-detected agreement for one model. `expected` comes from the
 * corruption layer (all-clean expectations for uncorrupted models), the
 * rest from the just-run checks. Every mismatch is a real finding: either
 * a planted defect the pipeline missed, or a phantom the pipeline invented.
 */
function computeAgreement(expected, schema, clash, quantities, degenerateProbes) {
  if (!expected || schema.ok === false || clash.ok === false) {
    return { ok: false, reason: 'checks did not complete' };
  }
  const detectedFootingClashes = clash.byRule?.['gym-footing-self'] ?? 0;
  const unmeshedProbes = Object.values(clash.probesMeshed ?? {}).filter((meshed) => !meshed).length;
  // Degenerate columns never had quantity sets, so the observable
  // missing-quantity count is planted removals plus planted degenerates.
  const expectedMissingQto = expected.missingQuantitySets + expected.unmeshedElementCount;
  const observedMissingQto = quantities
    ? quantities.quantifiableElements - quantities.elementsWithQuantities
    : null;

  const schemaMatch = schema.valid === expected.schemaValid;
  const clashMatch = detectedFootingClashes === expected.clashPairCount;
  const degenerateMatch = degenerateProbes.length === expected.unmeshedElementCount
    && unmeshedProbes === expected.unmeshedElementCount;
  const quantityMatch = observedMissingQto === null ? null : observedMissingQto === expectedMissingQto;

  return {
    ok: true,
    schemaMatch,
    clashMatch,
    degenerateMatch,
    quantityMatch,
    allMatch: schemaMatch && clashMatch && degenerateMatch && quantityMatch === true,
  };
}

/**
 * Compute the full manifest line for an already-generated model.
 *
 * `filePath` is where the content was (or would be) written - the
 * in-process engine labels straight from `model.content` in memory and only
 * uses `filePath` as an identifier, so callers running with keepFiles=false
 * never touch the disk at all.
 *
 * options.engine: 'in-process' (default, v2) | 'subprocess' (v1 parity/fallback).
 */
export async function labelModel(model, filePath, { skipChecks = false, engine = 'in-process' } = {}) {
  const t0 = performance.now();
  const sha256 = createHash('sha256').update(model.content, 'utf-8').digest('hex');

  const counts = entityCountsByType(model.entities);

  let schema = { ok: true, skipped: true };
  let clash = { ok: true, skipped: true };
  let quantities = null;
  let agreement = null;
  let degenerateProbes = [];

  if (!skipChecks) {
    if (engine === 'subprocess') {
      [schema, clash] = await Promise.all([schemaCheckSubprocess(filePath), clashCheckSubprocess(filePath)]);
    } else {
      try {
        const store = await parseStore(model.content, basename(filePath));
        schema = schemaCheckInProcess(store);
        degenerateProbes = findExpressIdsByNamePrefix(store, 'IFCCOLUMN', 'GymDegenerate');
        clash = await clashCheckInProcess(store, basename(filePath), degenerateProbes);
        quantities = extractQuantityTotals(store);
        agreement = computeAgreement(model.expected, schema, clash, quantities, degenerateProbes);
      } catch (err) {
        schema = { ok: false, error: String(err.message ?? err) };
        clash = { ok: false, error: String(err.message ?? err) };
      }
    }
  }

  const labelTimeMs = performance.now() - t0;

  // Keep the clash payload compact in the manifest: drop the per-pair list
  // for clean verdicts (it is always empty there anyway).
  const clashOut = clash.ok && Array.isArray(clash.pairs) && clash.total === 0
    ? { ...clash, pairs: undefined }
    : clash;

  return {
    seed: model.seed,
    family: model.family,
    params: model.params,
    file: filePath,
    sha256,
    entityCount: model.stats.entityCount,
    fileSize: model.stats.fileSize,
    entityCountsByType: counts,
    storeyCount: model.labels.storeyCount,
    groundTruth: model.labels,
    corrupted: model.corrupted ?? false,
    defects: model.defects ?? [],
    expected: model.expected ?? null,
    schemaCheck: schema,
    clash: clashOut,
    quantitiesExtracted: quantities,
    agreement,
    labelEngine: skipChecks ? 'skipped' : engine,
    labelTimeMs: Math.round(labelTimeMs),
  };
}

// ============================================================================
// CLI entry point - standalone single-model generate + label
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const hasFlag = (name) => args.includes(name);

  if (getFlag(args, '--seed') === undefined) {
    process.stderr.write('Usage: node labeler.mjs --seed <n> [--family frame|office|auto] [--corrupt | --corrupt-rate 0.3] [--engine in-process|subprocess] --model-dir <dir> [--skip-checks] [--json]\n');
    process.exit(1);
  }
  const seed = seedFlag(args, '--seed');
  const family = getFlag(args, '--family') ?? 'auto';
  const modelDir = getFlag(args, '--model-dir') ?? '.';
  const skipChecks = hasFlag('--skip-checks');
  const engine = getFlag(args, '--engine') ?? 'in-process';
  const forceCorrupt = hasFlag('--corrupt') ? true : undefined;
  if (forceCorrupt !== undefined && getFlag(args, '--corrupt-rate') !== undefined) {
    process.stderr.write('error: --corrupt and --corrupt-rate are mutually exclusive\n');
    process.exit(2);
  }
  const corruptRate = numberFlag(args, '--corrupt-rate', { def: 0, min: 0, max: 1 });

  if (engine === 'in-process' && !skipChecks) await initChecks();

  const model = generateModel(seed, family, { corruptRate, forceCorrupt });
  await mkdir(modelDir, { recursive: true });
  const filePath = join(modelDir, `${model.family}-${seed}.ifc`);
  await writeFile(filePath, model.content, 'utf-8');

  const line = await labelModel(model, filePath, { skipChecks, engine });
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}
