#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World Gym Benchmark - reference baselines (the leaderboard anchors).
 *
 * Three baselines, run over one split (default dev, 1,000 models):
 *
 * 1. `always-clean` - the degenerate floor: predicts no defects, zero
 *    quantities, constant triage. Anchors what "predicting the majority
 *    class / nothing" earns.
 * 2. `heuristic-text` - cheap structural/text signals over the raw STEP
 *    bytes, NO geometry kernel, no schema engine: entity-type counts
 *    (IFCSITE == 0, IFCPROJECT > 1, IFCFOOTING > 0), a duplicate-GUID scan,
 *    a reference-integrity scan, a depth-0 extrusion scan, a
 *    qset-vs-binding ratio check, and regex-level harvesting of the
 *    embedded GymQuantities values. Anchors what pattern-matching the
 *    corpus's synthetic corruption is worth WITHOUT understanding geometry.
 * 3. `oracle-kernel` - the kernel checks themselves (the exact in-process
 *    schema/clash/quantity pipeline the labeler runs), mapped to verdicts.
 *    The oracle-ish upper bound. It is deliberately NOT perfect: the kernel
 *    cannot see `dangling-ref` (a real validate gap, surfaced not hidden),
 *    and it can only re-extract quantities that survived corruption.
 *
 * Usage:
 *   node tools/world-gym/benchmark/baselines.mjs --split dev \
 *     --out-dir /path/outside/repo/wg-bench [--results-dir benchmark/results] \
 *     [--baselines always-clean,heuristic-text,oracle-kernel]
 *
 * Submission JSONL files go to --out-dir (corpus-scale artifacts, never the
 * repo). Leaderboard rows + the split summary (small JSONs) go to
 * --results-dir (committed).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { generateModel } from '../generator.mjs';
import {
  parseStore, schemaCheckInProcess, clashCheckInProcess, extractQuantityTotals, initChecks,
} from '../lib/checks.mjs';
import {
  BENCHMARK_NAME, SPEC_VERSION, CORRUPT_RATE, FAMILY, TASK_NAMES, DEFECT_TYPES, QUANTITY_KEYS, seedsForSplit,
} from './splits.mjs';
import { parseSubmission } from './submission.mjs';
import { regenerateTruth, scoreSubmission } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_NAMES = ['always-clean', 'heuristic-text', 'oracle-kernel'];

// ============================================================================
// Baseline 1: always-clean
// ============================================================================

export function alwaysCleanPrediction(seed) {
  const defects = {};
  for (const t of DEFECT_TYPES) defects[t] = false;
  const quantities = {};
  for (const k of QUANTITY_KEYS) quantities[k] = 0;
  return { seed, defects, quantities, triage: 0 };
}

// ============================================================================
// Baseline 2: heuristic-text (no kernel)
// ============================================================================

const DEF_RE = /^#(\d+)=([A-Z0-9_]+)\(/;

/** Cheap structural/text signals over raw STEP content. */
export function heuristicPrediction(seed, content) {
  const lines = content.split('\n');
  const typeCounts = {};
  const typeById = new Map();
  const guidCounts = new Map();
  const definedIds = new Set();
  const referencedIds = new Set();
  const qsetIds = new Set();
  const qtyValueById = new Map(); // quantity line id -> { name, value }
  const qsetQuantityIds = new Map(); // qset id -> [quantity ids]
  const relLines = []; // { elementIds, qsetId }
  let degenerateExtrusion = false;

  for (const line of lines) {
    const m = DEF_RE.exec(line);
    if (!m) continue;
    const id = m[1];
    const type = m[2];
    definedIds.add(id);
    typeById.set(id, type);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;

    // Every #ref after the '=' that is not this line's own id definition.
    const body = line.slice(line.indexOf('=') + 1);
    for (const ref of body.match(/#\d+/g) ?? []) referencedIds.add(ref.slice(1));

    // GUID scan: first attribute of every rooted entity is its GlobalId, a
    // 22-char base64 string. The length+charset filter keeps ordinary string
    // attributes (quantity names, labels) out of the duplicate count.
    const first = /^[A-Z0-9_]+\('([^']+)'/.exec(body)?.[1];
    if (first !== undefined && /^[0-9A-Za-z_$]{22}$/.test(first)) {
      guidCounts.set(first, (guidCounts.get(first) ?? 0) + 1);
    }

    if (type === 'IFCEXTRUDEDAREASOLID' && line.endsWith(',0.);')) degenerateExtrusion = true;
    if (type === 'IFCQUANTITYVOLUME' || type === 'IFCQUANTITYAREA') {
      const q = /^[A-Z0-9_]+\('([^']+)',[^,]*,[^,]*,([0-9.Ee+-]+)\)/.exec(body);
      if (q) qtyValueById.set(id, { name: q[1], value: Number(q[2]) });
    } else if (type === 'IFCELEMENTQUANTITY') {
      qsetIds.add(id);
      const list = /\(([^()]*)\)\);$/.exec(line)?.[1];
      qsetQuantityIds.set(id, (list?.match(/#\d+/g) ?? []).map((r) => r.slice(1)));
    } else if (type === 'IFCRELDEFINESBYPROPERTIES') {
      const rel = /,\(([^()]*)\),#(\d+)\);$/.exec(line);
      if (rel) relLines.push({ elementIds: (rel[1].match(/#\d+/g) ?? []).map((r) => r.slice(1)), qsetId: rel[2] });
    }
  }

  // --- defect verdicts ---
  const siteMissing = (typeCounts.IFCSITE ?? 0) === 0;
  const undefinedRefs = new Set([...referencedIds].filter((id) => !definedIds.has(id)));
  // A deleted site leaves exactly one distinct dangling id behind; anything
  // beyond that budget is an independent reference-integrity violation.
  const dangling = undefinedRefs.size > (siteMissing ? 1 : 0);
  const boundQsets = new Set(relLines.map((r) => r.qsetId).filter((id) => qsetIds.has(id)));
  const defects = {
    'clash-pair': (typeCounts.IFCFOOTING ?? 0) > 0,
    'degenerate-geometry': degenerateExtrusion,
    'duplicate-globalid': [...guidCounts.values()].some((n) => n > 1),
    'missing-site': siteMissing,
    'multiple-project': (typeCounts.IFCPROJECT ?? 0) > 1,
    'dangling-ref': dangling,
    'missing-quantities': boundQsets.size < qsetIds.size,
  };

  // --- quantity harvest (embedded GymQuantities values, regex only) ---
  const quantities = {};
  for (const k of QUANTITY_KEYS) quantities[k] = 0;
  const volumeKeyByType = {
    IFCWALL: 'wallGrossVolume',
    IFCSLAB: 'slabGrossVolume',
    IFCCOLUMN: 'columnGrossVolume',
    IFCBEAM: 'beamGrossVolume',
  };
  for (const { elementIds, qsetId } of relLines) {
    const qids = qsetQuantityIds.get(qsetId);
    if (!qids) continue;
    for (const elementId of elementIds) {
      const type = typeById.get(elementId);
      for (const qid of qids) {
        const q = qtyValueById.get(qid);
        if (!q || !Number.isFinite(q.value)) continue;
        if (q.name === 'GrossVolume' && volumeKeyByType[type]) quantities[volumeKeyByType[type]] += q.value;
        else if (q.name === 'NetFloorArea' && type === 'IFCSPACE') quantities.roomNetFloorArea += q.value;
      }
    }
  }

  const triage = DEFECT_TYPES.filter((t) => defects[t]).length;
  return { seed, defects, quantities, triage };
}

// ============================================================================
// Baseline 3: oracle-kernel (the kernel checks themselves)
// ============================================================================

export async function oraclePrediction(seed, content) {
  const store = await parseStore(content, `bench-${seed}.ifc`);
  const schema = schemaCheckInProcess(store);
  const columnIds = store.entityIndex.byType.get('IFCCOLUMN') ?? [];
  const clash = await clashCheckInProcess(store, `bench-${seed}.ifc`, columnIds);
  const q = extractQuantityTotals(store);

  const rules = new Set((schema.issues ?? []).map((i) => i.rule));
  const unmeshedColumns = Object.values(clash.probesMeshed ?? {}).filter((meshed) => !meshed).length;
  const defects = {
    'clash-pair': (clash.byRule?.['gym-footing-self'] ?? 0) > 0,
    'degenerate-geometry': unmeshedColumns > 0,
    'duplicate-globalid': rules.has('unique-globalid'),
    'missing-site': (schema.issues ?? []).some((i) => i.rule === 'required-entity' && i.message.includes('IFCSITE')),
    'multiple-project': rules.has('single-project'),
    // The kernel's validate has no reference-integrity rule: this is a real,
    // documented gap. The upper bound scores it honestly as a guaranteed miss.
    'dangling-ref': false,
    'missing-quantities': q.quantifiableElements - q.elementsWithQuantities > unmeshedColumns,
  };

  const quantities = {};
  for (const k of QUANTITY_KEYS) {
    const v = q[k];
    quantities[k] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  }

  const triage = DEFECT_TYPES.filter((t) => defects[t]).length;
  return { seed, defects, quantities, triage };
}

// ============================================================================
// Runner
// ============================================================================

function submissionText(name, split, predictions) {
  const header = { type: 'header', benchmark: BENCHMARK_NAME, specVersion: SPEC_VERSION, split, name, tasks: TASK_NAMES };
  return [header, ...predictions].map((o) => JSON.stringify(o)).join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const split = getFlag('--split') ?? 'dev';
  const outDirRaw = getFlag('--out-dir');
  const resultsDir = resolve(getFlag('--results-dir') ?? join(HERE, 'results'));
  const which = (getFlag('--baselines') ?? BASELINE_NAMES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const b of which) {
    if (!BASELINE_NAMES.includes(b)) {
      process.stderr.write(`Unknown baseline "${b}" (known: ${BASELINE_NAMES.join(', ')})\n`);
      process.exit(1);
    }
  }
  if (!outDirRaw) {
    process.stderr.write('Usage: node baselines.mjs --split dev --out-dir <dir outside the repo> [--results-dir <dir>] [--baselines a,b,c]\n');
    process.exit(1);
  }
  const outDir = resolve(outDirRaw);
  await mkdir(outDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });

  const needsOracle = which.includes('oracle-kernel');
  if (needsOracle) {
    process.stderr.write('Warming WASM geometry processor for oracle-kernel...\n');
    await initChecks();
  }

  const seeds = seedsForSplit(split);
  process.stderr.write(`Baselines [${which.join(', ')}] over split "${split}" (${seeds.length} models, spec ${SPEC_VERSION})...\n`);

  const predictions = Object.fromEntries(which.map((b) => [b, []]));
  // Split summary bookkeeping (from generation ground truth, not from checks).
  const summaryAcc = {
    models: 0, clean: 0, corrupted: 0,
    familyCounts: {}, defectTypeCounts: {}, severityHistogram: {},
    entityCounts: [],
  };

  const t0 = performance.now();
  let done = 0;
  for (const seed of seeds) {
    const model = generateModel(seed, FAMILY, { corruptRate: CORRUPT_RATE });

    summaryAcc.models++;
    if (model.corrupted) summaryAcc.corrupted++; else summaryAcc.clean++;
    summaryAcc.familyCounts[model.family] = (summaryAcc.familyCounts[model.family] ?? 0) + 1;
    const types = new Set(model.defects.map((d) => d.type));
    for (const t of types) summaryAcc.defectTypeCounts[t] = (summaryAcc.defectTypeCounts[t] ?? 0) + 1;
    summaryAcc.severityHistogram[types.size] = (summaryAcc.severityHistogram[types.size] ?? 0) + 1;
    summaryAcc.entityCounts.push(model.stats.entityCount);

    if (which.includes('always-clean')) predictions['always-clean'].push(alwaysCleanPrediction(seed));
    if (which.includes('heuristic-text')) predictions['heuristic-text'].push(heuristicPrediction(seed, model.content));
    if (needsOracle) predictions['oracle-kernel'].push(await oraclePrediction(seed, model.content));

    done++;
    if (done % 100 === 0 || done === seeds.length) {
      process.stderr.write(`  ${done}/${seeds.length} (${((performance.now() - t0) / 1000).toFixed(1)}s)\n`);
    }
  }

  // Round-trip each baseline through the REAL submission file + validator +
  // scorer - the baselines exercise the exact external-submitter path.
  process.stderr.write('Regenerating ground truth for scoring...\n');
  const truthBySeed = regenerateTruth(split);

  const rows = [];
  for (const name of which) {
    const text = submissionText(name, split, predictions[name]);
    const subPath = join(outDir, `submission-${name}-${split}.jsonl`);
    await writeFile(subPath, text, 'utf-8');
    const parsed = parseSubmission(text, split);
    if (!parsed.ok) {
      process.stderr.write(`BUG: baseline "${name}" produced an invalid submission:\n${parsed.errors.map((e) => `  - ${e}`).join('\n')}\n`);
      process.exit(1);
    }
    const row = scoreSubmission(parsed.header, parsed.lines, split, truthBySeed);
    rows.push(row);
    await writeFile(join(resultsDir, `row-${name}-${split}.json`), `${JSON.stringify(row, null, 2)}\n`, 'utf-8');
    process.stderr.write(`  ${name}: aggregate=${row.scores.aggregate} defect=${row.scores['defect-detection']} quantity=${row.scores['quantity-estimation']} triage=${row.scores['validity-triage']} (submission: ${subPath})\n`);
  }

  const sortedEntities = summaryAcc.entityCounts.sort((a, b) => a - b);
  const splitSummary = {
    benchmark: BENCHMARK_NAME,
    specVersion: SPEC_VERSION,
    split,
    models: summaryAcc.models,
    clean: summaryAcc.clean,
    corrupted: summaryAcc.corrupted,
    corruptRate: CORRUPT_RATE,
    familyCounts: summaryAcc.familyCounts,
    defectTypeCounts: summaryAcc.defectTypeCounts,
    severityHistogram: summaryAcc.severityHistogram,
    entityCountDistribution: {
      min: sortedEntities[0] ?? null,
      median: sortedEntities[Math.floor(sortedEntities.length / 2)] ?? null,
      max: sortedEntities[sortedEntities.length - 1] ?? null,
    },
  };
  await writeFile(join(resultsDir, `split-summary-${split}.json`), `${JSON.stringify(splitSummary, null, 2)}\n`, 'utf-8');

  const leaderboard = {
    benchmark: BENCHMARK_NAME,
    specVersion: SPEC_VERSION,
    split,
    note: 'Reference baselines (leaderboard anchors). Rows sorted by aggregate, descending.',
    rows: rows
      .slice()
      .sort((a, b) => (b.scores.aggregate ?? -1) - (a.scores.aggregate ?? -1))
      .map((r) => ({ name: r.name, scores: r.scores })),
  };
  await writeFile(join(resultsDir, `leaderboard-${split}.json`), `${JSON.stringify(leaderboard, null, 2)}\n`, 'utf-8');

  process.stdout.write(`${JSON.stringify(leaderboard, null, 2)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}
