#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World Gym pilot runner (M2 midterm, B1.2).
 *
 * Generates + labels N models (default 1000) across a worker pool sized to
 * the machine's cores, writing one manifest.jsonl line per model plus a
 * summary.json with timing, dedup, and label-coverage stats. This is the
 * "data factory" pilot: the same code path is meant to scale to 100k by
 * just raising --count and running on more/bigger machines (see README).
 *
 * Usage:
 *   node run-pilot.mjs --count 1000 --out-dir <dir> [--workers N] [--family frame|office|auto] \
 *     [--seed-start 0] [--skip-checks] [--corrupt-rate 0.3] [--engine in-process|subprocess] [--no-keep-files]
 *
 * --corrupt-rate: fraction of seeds (Bernoulli per seed, deterministic) that
 *   carry known-by-construction defects - the negative-label half of the
 *   corpus (see lib/corruption.mjs).
 * --engine: label-check engine. 'in-process' (default) warms one WASM
 *   geometry processor per worker; 'subprocess' is the v1 two-CLI-launches
 *   path, kept for A/B throughput comparison.
 * --no-keep-files: skip writing .ifc files (labels run from memory; any
 *   model is reproducible from its seed) - for large corpus runs where the
 *   manifest is the deliverable and 10-20 GB of STEP text is not.
 *
 * IMPORTANT: --out-dir is required and must point outside the repo (this
 * tool's own path is tools/world-gym/**; generated corpora are pilot
 * artifacts, not source, and must not be committed).
 */

import { fork } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { cpus } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HERE, 'worker.mjs');

function getFlag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(args, name) {
  return args.includes(name);
}

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

class WorkerPool {
  constructor(size, modelDir, skipChecks, { engine = 'in-process', corruptRate = 0, keepFiles = true } = {}) {
    this.size = size;
    this.modelDir = modelDir;
    this.skipChecks = skipChecks;
    this.engine = engine;
    this.corruptRate = corruptRate;
    this.keepFiles = keepFiles;
    this.workers = [];
    this.idle = [];
    this.pending = new Map(); // seed -> { resolve, reject }
  }

  async start() {
    const readyPromises = [];
    for (let i = 0; i < this.size; i++) {
      const child = fork(WORKER_PATH, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      const readyPromise = new Promise((resolveReady) => {
        const onMessage = (msg) => {
          if (msg.type === 'ready') {
            child.off('message', onMessage);
            resolveReady();
          }
        };
        child.on('message', onMessage);
      });
      child.on('message', (msg) => this._handleMessage(child, msg));
      child.send({
        type: 'init',
        modelDir: this.modelDir,
        skipChecks: this.skipChecks,
        engine: this.engine,
        corruptRate: this.corruptRate,
        keepFiles: this.keepFiles,
      });
      this.workers.push(child);
      readyPromises.push(readyPromise);
    }
    await Promise.all(readyPromises);
    this.idle = [...this.workers];
  }

  _handleMessage(child, msg) {
    if (msg.type === 'ready') return;
    const job = this.pending.get(msg.seed);
    this.idle.push(child);
    this._drainQueue();
    if (!job) return;
    this.pending.delete(msg.seed);
    if (msg.type === 'result') {
      job.resolve({ line: msg.line, genTimeMs: msg.genTimeMs, totalTimeMs: msg.totalTimeMs });
    } else {
      job.reject(new Error(msg.error));
    }
  }

  _drainQueue() {
    while (this.idle.length > 0 && this.queue && this.queue.length > 0) {
      const child = this.idle.pop();
      const { seed, family } = this.queue.shift();
      child.send({ type: 'job', seed, family });
    }
  }

  /** Run one job - resolves with the worker's result or rejects with its error. */
  runJob(seed, family) {
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(seed, { resolve: resolvePromise, reject: rejectPromise });
      if (this.idle.length > 0) {
        const child = this.idle.pop();
        child.send({ type: 'job', seed, family });
      } else {
        this.queue = this.queue ?? [];
        this.queue.push({ seed, family });
      }
    });
  }

  async shutdown() {
    for (const w of this.workers) {
      w.send({ type: 'shutdown' });
    }
    await new Promise((r) => setTimeout(r, 100));
    for (const w of this.workers) {
      if (!w.killed) w.kill();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const count = Number(getFlag(args, '--count') ?? 1000);
  const seedStart = Number(getFlag(args, '--seed-start') ?? 0);
  const family = getFlag(args, '--family') ?? 'auto';
  const workerCount = Number(getFlag(args, '--workers') ?? cpus().length);
  const outDirRaw = getFlag(args, '--out-dir');
  const skipChecks = hasFlag(args, '--skip-checks');
  const engine = getFlag(args, '--engine') ?? 'in-process';
  const corruptRate = Number(getFlag(args, '--corrupt-rate') ?? 0);
  const keepFiles = !hasFlag(args, '--no-keep-files');

  if (!outDirRaw) {
    process.stderr.write('Usage: node run-pilot.mjs --count 1000 --out-dir <dir> [--workers N] [--family frame|office|auto] [--seed-start 0] [--skip-checks] [--corrupt-rate 0.3] [--engine in-process|subprocess] [--no-keep-files]\n');
    process.exit(1);
  }
  const outDir = resolve(outDirRaw);
  const modelDir = join(outDir, 'models');
  await mkdir(keepFiles ? modelDir : outDir, { recursive: true });

  process.stderr.write(`World Gym pilot: ${count} models, ${workerCount} workers, family=${family}, engine=${engine}, corruptRate=${corruptRate}, keepFiles=${keepFiles}, out=${outDir}\n`);

  const pool = new WorkerPool(workerCount, modelDir, skipChecks, { engine, corruptRate, keepFiles });
  const poolStartT0 = performance.now();
  await pool.start();
  const poolStartMs = performance.now() - poolStartT0;

  const manifestPath = join(outDir, 'manifest.jsonl');
  // Stream manifest lines to disk as they arrive: at 100k models the
  // manifest is hundreds of MB and must not accumulate in this process.
  const manifestStream = createWriteStream(manifestPath, { encoding: 'utf-8' });
  let manifestCount = 0;
  const shaSeeds = new Map(); // sha256 -> [seed, ...]
  const errors = [];
  const entityCounts = [];
  const genTimesMs = [];
  const totalTimesMs = [];
  const familyCounts = {};
  let checksOkCount = 0;
  // Negative-label / discrimination bookkeeping.
  let corruptedCount = 0;
  const defectTypeCounts = {};
  let schemaValidCount = 0;
  let schemaInvalidCount = 0;
  const clashTotalHist = {}; // clash total -> model count
  const agreementCounts = { evaluated: 0, allMatch: 0, schemaMatch: 0, clashMatch: 0, degenerateMatch: 0, quantityMatch: 0 };

  const wallT0 = performance.now();
  let completed = 0;
  const jobs = [];
  for (let i = 0; i < count; i++) {
    jobs.push({ seed: seedStart + i, family });
  }

  await Promise.all(jobs.map(async ({ seed, family: fam }) => {
    try {
      const { line, genTimeMs, totalTimeMs } = await pool.runJob(seed, fam);
      manifestStream.write(`${JSON.stringify(line)}\n`);
      manifestCount++;
      entityCounts.push(line.entityCount);
      genTimesMs.push(genTimeMs);
      totalTimesMs.push(totalTimeMs);
      familyCounts[line.family] = (familyCounts[line.family] ?? 0) + 1;
      const seeds = shaSeeds.get(line.sha256) ?? [];
      seeds.push(seed);
      shaSeeds.set(line.sha256, seeds);
      const schemaOk = line.schemaCheck?.ok !== false && (line.schemaCheck?.skipped || line.schemaCheck?.valid !== undefined);
      const clashOk = line.clash?.ok !== false && (line.clash?.skipped || line.clash?.total !== undefined);
      if (schemaOk && clashOk) checksOkCount++;
      if (line.corrupted) {
        corruptedCount++;
        for (const d of line.defects ?? []) {
          defectTypeCounts[d.type] = (defectTypeCounts[d.type] ?? 0) + 1;
        }
      }
      if (line.schemaCheck?.valid === true) schemaValidCount++;
      else if (line.schemaCheck?.valid === false) schemaInvalidCount++;
      if (typeof line.clash?.total === 'number') {
        clashTotalHist[line.clash.total] = (clashTotalHist[line.clash.total] ?? 0) + 1;
      }
      if (line.agreement?.ok) {
        agreementCounts.evaluated++;
        if (line.agreement.allMatch) agreementCounts.allMatch++;
        if (line.agreement.schemaMatch) agreementCounts.schemaMatch++;
        if (line.agreement.clashMatch) agreementCounts.clashMatch++;
        if (line.agreement.degenerateMatch) agreementCounts.degenerateMatch++;
        if (line.agreement.quantityMatch) agreementCounts.quantityMatch++;
      }
    } catch (err) {
      errors.push({ seed, error: String(err.message ?? err) });
    } finally {
      completed++;
      if (completed % Math.max(1, Math.floor(count / 20)) === 0 || completed === count) {
        process.stderr.write(`  ${completed}/${count} models done\n`);
      }
    }
  }));

  const wallMs = performance.now() - wallT0;
  await pool.shutdown();

  await new Promise((res, rej) => manifestStream.end((err) => (err ? rej(err) : res())));

  const sortedEntities = [...entityCounts].sort((a, b) => a - b);
  const sortedGen = [...genTimesMs].sort((a, b) => a - b);
  const sortedTotal = [...totalTimesMs].sort((a, b) => a - b);
  const duplicateGroups = [...shaSeeds.entries()].filter(([, seeds]) => seeds.length > 1);
  const dedupRate = manifestCount > 0 ? duplicateGroups.length / manifestCount : 0;
  const modelsPerSec = manifestCount / (wallMs / 1000);
  const cores = cpus().length;
  const estimated100kHours = manifestCount > 0
    ? (100_000 / modelsPerSec) / 3600
    : null;

  const summary = {
    requested: count,
    completed: manifestCount,
    failed: errors.length,
    seedRange: [seedStart, seedStart + count - 1],
    family,
    engine,
    corruptRate,
    keepFiles,
    workers: workerCount,
    cores,
    poolStartMs: Math.round(poolStartMs),
    wallTimeMs: Math.round(wallMs),
    modelsPerSec: Number(modelsPerSec.toFixed(3)),
    dedup: {
      uniqueContentHashes: shaSeeds.size,
      duplicateGroups: duplicateGroups.length,
      duplicateGroupDetail: duplicateGroups.slice(0, 20),
      dedupRate: Number(dedupRate.toFixed(6)),
    },
    labelCoverage: {
      modelsWithFullLabels: checksOkCount,
      coverageRate: manifestCount > 0 ? Number((checksOkCount / manifestCount).toFixed(4)) : 0,
      skippedChecks: skipChecks,
    },
    labelClasses: {
      clean: manifestCount - corruptedCount,
      corrupted: corruptedCount,
      defectTypeCounts,
      schemaValidCount,
      schemaInvalidCount,
      clashTotalHistogram: clashTotalHist,
    },
    groundTruthAgreement: {
      note: 'expected-vs-detected per model: planted defects (or all-clean expectations) compared against what the checks actually saw',
      ...agreementCounts,
      allMatchRate: agreementCounts.evaluated > 0
        ? Number((agreementCounts.allMatch / agreementCounts.evaluated).toFixed(4))
        : null,
    },
    familyDistribution: familyCounts,
    entityCountDistribution: {
      min: sortedEntities[0] ?? null,
      median: median(sortedEntities),
      p95: percentile(sortedEntities, 95),
      max: sortedEntities[sortedEntities.length - 1] ?? null,
    },
    timingMs: {
      generation: { min: sortedGen[0] ?? null, median: median(sortedGen), p95: percentile(sortedGen, 95), max: sortedGen[sortedGen.length - 1] ?? null },
      totalPerModel: { min: sortedTotal[0] ?? null, median: median(sortedTotal), p95: percentile(sortedTotal, 95), max: sortedTotal[sortedTotal.length - 1] ?? null },
    },
    extrapolation: {
      note: 'Linear extrapolation from this run\'s models/sec on this machine; see README for the real scaling plan (more cores, batched CLI checks, distributed workers).',
      thisMachineCores: cores,
      estimatedHoursFor100k: estimated100kHours !== null ? Number(estimated100kHours.toFixed(3)) : null,
    },
    errors: errors.slice(0, 50),
    manifestPath,
  };

  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
