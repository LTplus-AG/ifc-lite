#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World Gym deterministic labeler (M2 midterm, B1.2).
 *
 * Two label sources, on purpose:
 *
 * 1. Generation-parameter ground truth (free, exact, zero re-derivation
 *    risk): entity counts by type come straight from IfcCreator's own
 *    `result.entities`; storey count and every quantity (wall area, slab
 *    volume, room area, ...) come straight from the family module's
 *    `build()` return value — the same numbers used to author the geometry
 *    and the embedded IfcElementQuantity sets. This is what "perfect
 *    ground truth" means here: the label was never re-inferred from the
 *    serialized file, so it cannot drift from what was actually built.
 *
 * 2. Checks that can only be answered by actually running the pipeline on
 *    the serialized bytes: schema/structural validity and clash count.
 *    These reuse the CLI's own `validate` and `clash` commands (subprocess,
 *    `--json`) rather than reimplementing that logic here — per instructions,
 *    "reuse, don't reimplement." (The plan referenced an `ifc-lite gym`
 *    reset line; it does not exist in this worktree — see README gap notes.)
 *
 * GAP (documented, not fixed here — out of tools/world-gym's own path):
 * `ifc-lite clash --json` writes non-JSON diagnostic lines
 * (`[IFC-LITE] Opening classifier...`, `rect_fast: fired...`) to stdout
 * *before* the JSON payload. They come from the geometry/opening-cutting
 * pipeline's own console.log calls deep under GeometryProcessor, which are
 * not gated by --json or any --quiet flag. Naive `JSON.parse(stdout)`
 * breaks. Worked around here via `extractTrailingJson()`, which locates the
 * first stdout line that is exactly `{` (pretty-printed JSON.stringify's
 * opening brace; no diagnostic line matches that shape) and parses from
 * there. Should be fixed upstream in packages/cli or packages/geometry.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { generateModel } from './generator.mjs';

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

/** Schema/structural validity — reuses `ifc-lite validate --json`. */
async function schemaCheck(filePath) {
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

/** Clash count — reuses `ifc-lite clash --matrix --json` (full discipline matrix, hard mode). */
async function clashCheck(filePath) {
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
 * Compute the full manifest line for an already-generated model.
 * `model` is `generateModel()`'s return value; `filePath` is where its
 * `.content` was (or will be) written to disk — needed because
 * validate/clash operate on a file path, not in-memory bytes.
 */
export async function labelModel(model, filePath, { skipChecks = false } = {}) {
  const t0 = performance.now();
  const sha256 = createHash('sha256').update(model.content, 'utf-8').digest('hex');

  const counts = entityCountsByType(model.entities);

  let schema = { ok: true, skipped: true };
  let clash = { ok: true, skipped: true };
  if (!skipChecks) {
    [schema, clash] = await Promise.all([schemaCheck(filePath), clashCheck(filePath)]);
  }

  const labelTimeMs = performance.now() - t0;

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
    schemaCheck: schema,
    clash,
    labelTimeMs: Math.round(labelTimeMs),
  };
}

// ============================================================================
// CLI entry point — standalone single-model generate + label
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const hasFlag = (name) => args.includes(name);

  const seedRaw = getFlag('--seed');
  if (seedRaw === undefined) {
    process.stderr.write('Usage: node labeler.mjs --seed <n> [--family frame|office|auto] --model-dir <dir> [--skip-checks] [--json]\n');
    process.exit(1);
  }
  const seed = Number.isFinite(Number(seedRaw)) ? Number(seedRaw) : seedRaw;
  const family = getFlag('--family') ?? 'auto';
  const modelDir = getFlag('--model-dir') ?? '.';
  const skipChecks = hasFlag('--skip-checks');

  const model = generateModel(seed, family);
  await mkdir(modelDir, { recursive: true });
  const filePath = join(modelDir, `${model.family}-${seed}.ifc`);
  await writeFile(filePath, model.content, 'utf-8');

  const line = await labelModel(model, filePath, { skipChecks });
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}
