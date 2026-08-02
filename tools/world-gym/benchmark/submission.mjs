/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World Gym Benchmark - submission format (parse + validate).
 *
 * A submission is one JSONL file:
 *
 *   line 1 (header):
 *     {"type":"header","benchmark":"ifc-lite-world-gym","specVersion":"1.0.0",
 *      "split":"dev","name":"my-method","tasks":["defect-detection", ...]}
 *   every following line (one per seed in the split, any order):
 *     {"seed":8,
 *      "defects":{"clash-pair":false, ... all 7 types ...},        // if defect-detection submitted
 *      "quantities":{"wallGrossVolume":12.3, ... all 5 keys ...},  // if quantity-estimation submitted
 *      "triage":0.7}                                               // if validity-triage submitted
 *
 * Rules enforced here (see BENCHMARK.md for the rationale):
 * - header first, exactly once; benchmark/specVersion/split must match.
 * - `tasks` is a non-empty subset of the three task names; every model line
 *   must carry exactly the fields those tasks require.
 * - every seed of the split appears exactly once; no seeds outside the split.
 * - defect verdicts are booleans for all 7 defect types; quantities are
 *   finite numbers >= 0 for all 5 keys (predict 0 for keys a family does not
 *   have - non-applicable keys are never scored); triage is a finite number
 *   (any real; only its ordering matters).
 *
 * Errors are collected (up to MAX_ERRORS) with line numbers, not thrown one
 * at a time, so a submitter sees everything wrong in one pass.
 */

import { BENCHMARK_NAME, SPEC_VERSION, SPLIT_NAMES, TASK_NAMES, DEFECT_TYPES, QUANTITY_KEYS, seedsForSplit, splitOf } from './splits.mjs';

const MAX_ERRORS = 25;

/**
 * Parse + validate a submission against `expectedSplit`.
 * @param {string} text - the raw JSONL file content
 * @param {string} expectedSplit - 'train' | 'dev' | 'test'
 * @returns {{ ok: boolean, errors: string[], header: object|null, lines: Map<number, object> }}
 */
export function parseSubmission(text, expectedSplit) {
  const errors = [];
  const err = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); };
  const lines = new Map(); // seed -> model line
  let header = null;

  if (!SPLIT_NAMES.includes(expectedSplit)) {
    return { ok: false, errors: [`unknown split "${expectedSplit}" (known: ${SPLIT_NAMES.join(', ')})`], header, lines };
  }

  const rawLines = text.split('\n');
  let lineNo = 0;
  for (const raw of rawLines) {
    lineNo++;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      err(`line ${lineNo}: not valid JSON (${e.message})`);
      continue;
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      err(`line ${lineNo}: expected a JSON object`);
      continue;
    }

    if (header === null) {
      // First non-empty line must be the header.
      if (obj.type !== 'header') {
        err(`line ${lineNo}: first line must be the header object ({"type":"header",...}), got ${JSON.stringify(obj.type ?? null)}`);
        return { ok: false, errors, header, lines };
      }
      header = validateHeader(obj, expectedSplit, err, lineNo);
      if (!header) return { ok: false, errors, header: null, lines };
      continue;
    }

    if (obj.type === 'header') {
      err(`line ${lineNo}: duplicate header`);
      continue;
    }
    validateModelLine(obj, header.tasks, err, lineNo, lines, expectedSplit);
  }

  if (header === null) {
    err('submission is empty (no header line)');
    return { ok: false, errors, header, lines };
  }

  // Coverage: every seed of the split exactly once.
  const splitSeeds = seedsForSplit(expectedSplit);
  const missing = splitSeeds.filter((s) => !lines.has(s));
  if (missing.length > 0) {
    err(`missing ${missing.length}/${splitSeeds.length} seeds of split "${expectedSplit}" (first missing: ${missing.slice(0, 5).join(', ')})`);
  }

  return { ok: errors.length === 0, errors, header, lines };
}

function validateHeader(obj, expectedSplit, err, lineNo) {
  let ok = true;
  if (obj.benchmark !== BENCHMARK_NAME) {
    err(`line ${lineNo}: header.benchmark must be "${BENCHMARK_NAME}", got ${JSON.stringify(obj.benchmark ?? null)}`);
    ok = false;
  }
  if (obj.specVersion !== SPEC_VERSION) {
    err(`line ${lineNo}: header.specVersion must be "${SPEC_VERSION}" (rows across versions are not comparable), got ${JSON.stringify(obj.specVersion ?? null)}`);
    ok = false;
  }
  if (obj.split !== expectedSplit) {
    err(`line ${lineNo}: header.split is ${JSON.stringify(obj.split ?? null)} but scoring was requested for "${expectedSplit}"`);
    ok = false;
  }
  if (typeof obj.name !== 'string' || obj.name.length === 0 || obj.name.length > 100) {
    err(`line ${lineNo}: header.name must be a non-empty string (max 100 chars)`);
    ok = false;
  }
  const tasks = obj.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.some((t) => !TASK_NAMES.includes(t)) || new Set(tasks).size !== tasks.length) {
    err(`line ${lineNo}: header.tasks must be a non-empty subset of [${TASK_NAMES.join(', ')}] with no duplicates`);
    ok = false;
  }
  return ok ? { ...obj, tasks: TASK_NAMES.filter((t) => tasks.includes(t)) } : null;
}

function validateModelLine(obj, tasks, err, lineNo, lines, expectedSplit) {
  const seed = obj.seed;
  if (!Number.isInteger(seed) || seed < 0) {
    err(`line ${lineNo}: "seed" must be a non-negative integer, got ${JSON.stringify(seed ?? null)}`);
    return;
  }
  const seedSplit = splitOf(seed);
  if (seedSplit !== expectedSplit) {
    err(`line ${lineNo}: seed ${seed} is not in split "${expectedSplit}" (it is ${seedSplit === null ? 'outside the benchmark universe' : `in "${seedSplit}"`})`);
    return;
  }
  if (lines.has(seed)) {
    err(`line ${lineNo}: duplicate prediction for seed ${seed}`);
    return;
  }

  // Strict top-level shape: only the fields for the DECLARED tasks are
  // allowed. Payloads for unselected tasks (or arbitrary extra fields) are
  // rejected rather than silently ignored - a submitter who sends "triage"
  // without declaring validity-triage should hear about it, not lose it.
  const allowedKeys = new Set(['seed']);
  if (tasks.includes('defect-detection')) allowedKeys.add('defects');
  if (tasks.includes('quantity-estimation')) allowedKeys.add('quantities');
  if (tasks.includes('validity-triage')) allowedKeys.add('triage');
  const unknownKeys = Object.keys(obj).filter((k) => !allowedKeys.has(k));
  if (unknownKeys.length > 0) {
    err(`line ${lineNo}: seed ${seed}: field(s) not declared by header.tasks: ${unknownKeys.join(', ')} (allowed: ${[...allowedKeys].join(', ')})`);
    return;
  }

  if (tasks.includes('defect-detection')) {
    const d = obj.defects;
    if (d === null || typeof d !== 'object' || Array.isArray(d)) {
      err(`line ${lineNo}: seed ${seed}: "defects" must be an object with a boolean per defect type`);
      return;
    }
    for (const type of DEFECT_TYPES) {
      if (typeof d[type] !== 'boolean') {
        err(`line ${lineNo}: seed ${seed}: defects["${type}"] must be a boolean (all 7 types are required: ${DEFECT_TYPES.join(', ')})`);
        return;
      }
    }
    const extra = Object.keys(d).filter((k) => !DEFECT_TYPES.includes(k));
    if (extra.length > 0) {
      err(`line ${lineNo}: seed ${seed}: unknown defect type(s): ${extra.join(', ')}`);
      return;
    }
  }

  if (tasks.includes('quantity-estimation')) {
    const q = obj.quantities;
    if (q === null || typeof q !== 'object' || Array.isArray(q)) {
      err(`line ${lineNo}: seed ${seed}: "quantities" must be an object with a number per quantity key`);
      return;
    }
    for (const key of QUANTITY_KEYS) {
      const v = q[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        err(`line ${lineNo}: seed ${seed}: quantities["${key}"] must be a finite number >= 0 (all 5 keys are required; predict 0 for non-applicable keys)`);
        return;
      }
    }
  }

  if (tasks.includes('validity-triage')) {
    if (typeof obj.triage !== 'number' || !Number.isFinite(obj.triage)) {
      err(`line ${lineNo}: seed ${seed}: "triage" must be a finite number (higher = more defective)`);
      return;
    }
  }

  lines.set(seed, obj);
}
