#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.2 pass 2 of 4: the World Gym kernel checks, run verbatim on a foreign
 * model, with the DETAIL the benchmark's verdict mapping throws away.
 *
 * Everything here is imported unmodified from tools/world-gym/lib/checks.mjs:
 * `parseStore` (the loader `ifc-lite` itself uses), `schemaCheckInProcess`
 * (literally `computeValidationIssues`, i.e. what `ifc-lite validate` runs),
 * `clashCheckInProcess` (GeometryProcessor + elementsFromStep + the clash
 * engine with the discipline matrix plus the gym footing rule), and
 * `extractQuantityTotals` (the GymQuantities re-read). Nothing in
 * tools/world-gym is edited by this bet - the measurement IS the existing
 * instrument meeting input it was not tuned on.
 *
 * It also harvests the model's AUTHORED IfcElementQuantity sets, which the
 * synthetic corpus only ever carries under the single pset name
 * `GymQuantities`. That harvest is what makes a real quantity comparison
 * possible at all (see run-qto-pass.mjs, which pairs it with kernel-computed
 * mesh volumes).
 *
 * PRIVACY. No validation message text is emitted, only its rule, severity and
 * count, plus the counts this script recomputes itself from the store. No
 * clash pair names are emitted (they are authored element names). Authored
 * quantity vocabulary is emitted only where it is buildingSMART-standard.
 *
 * Usage:
 *   node --max-old-space-size=10240 run-kernel-pass.mjs \
 *     --model <abs path> --alias model-a --out <dir>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseStore, schemaCheckInProcess, clashCheckInProcess, extractQuantityTotals, initChecks,
} from '../../../tools/world-gym/lib/checks.mjs';
import { coarseMegabytes, standardNameOrPlaceholder, round } from './lib/model-id.mjs';

const { EntityNode } = await import('../../../packages/query/dist/index.js');

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const modelPath = flag('--model');
const alias = flag('--alias');
const outDir = flag('--out');
if (!modelPath || !alias || !outDir) {
  process.stderr.write('Usage: run-kernel-pass.mjs --model <path> --alias <id> --out <dir>\n');
  process.exit(2);
}

const mem = () => round(process.memoryUsage().rss / 1e6, 1);

const bytes = await readFile(modelPath);

process.stderr.write('warming geometry processor...\n');
const tWarm = performance.now();
await initChecks();
const warmMs = performance.now() - tWarm;

process.stderr.write('parsing...\n');
const tParse = performance.now();
const store = await parseStore(bytes, `${alias}.ifc`);
const parseMs = performance.now() - tParse;
const rssAfterParse = mem();

process.stderr.write('schema check...\n');
const tSchema = performance.now();
const schema = schemaCheckInProcess(store);
const schemaMs = performance.now() - tSchema;

// Rule x severity counts only. Message TEXT is never emitted (see PRIVACY).
const byRule = {};
for (const iss of schema.issues) {
  const key = `${iss.rule}/${iss.severity}`;
  const slot = (byRule[key] ??= { rule: iss.rule, severity: iss.severity, count: 0 });
  slot.count += 1;
}

process.stderr.write('clash check (geometry)...\n');
const columnIds = store.entityIndex.byType.get('IFCCOLUMN') ?? [];
const tClash = performance.now();
const clash = await clashCheckInProcess(store, `${alias}.ifc`, columnIds);
const clashMs = performance.now() - tClash;
const rssAfterGeometry = mem();

const probeVals = Object.values(clash.probesMeshed ?? {});
const unmeshedColumns = probeVals.filter((m) => !m).length;

process.stderr.write('gym quantity re-read...\n');
const gymQuantities = extractQuantityTotals(store);

// --- authored IfcElementQuantity harvest -----------------------------------
// Which quantity-set NAMES and quantity NAMES does a real file actually use?
// The corpus knows exactly one ('GymQuantities'), so this measures how far the
// benchmark's quantity task sits from a real file's vocabulary. The
// quantifiable type list is `computeValidationIssues`'s own list, so
// `elementsWithoutQset` here reproduces the number inside the
// quantity-completeness issue without quoting its message.
const QUANTIFIABLE_VALIDATE = [
  'IFCWALL', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCDOOR', 'IFCWINDOW',
  'IFCSTAIR', 'IFCROOF', 'IFCSPACE', 'IFCMEMBER', 'IFCPLATE', 'IFCFOOTING',
  'IFCWALLSTANDARDCASE', 'IFCSLABSTANDARDCASE', 'IFCBEAMSTANDARDCASE',
  'IFCCOLUMNSTANDARDCASE', 'IFCDOORSTANDARDCASE', 'IFCWINDOWSTANDARDCASE',
];
const qsetNameCounts = {};
const qtyNameCounts = {};
// Distinct RAW authored names, counted but never emitted by name. Without
// these the `distinctCollapsed*` figures below read as "this file uses one
// quantity-set name" when what they mean is "this file's quantity-set names
// collapse onto one label after the standard-vocabulary filter".
const authoredQsetNames = new Set();
const authoredQuantityNames = new Set();
let elementsChecked = 0;
let elementsWithAnyQset = 0;
let standardQsetHits = 0;
let nonStandardQsetHits = 0;
for (const type of QUANTIFIABLE_VALIDATE) {
  for (const eid of store.entityIndex.byType.get(type) ?? []) {
    elementsChecked += 1;
    const qsets = new EntityNode(store, eid).quantities();
    if (qsets.length > 0) elementsWithAnyQset += 1;
    for (const qs of qsets) {
      const safe = standardNameOrPlaceholder(qs.name, 'qset');
      if (safe === '<non-standard>') nonStandardQsetHits += 1; else standardQsetHits += 1;
      if (typeof qs.name === 'string') authoredQsetNames.add(qs.name);
      qsetNameCounts[safe] = (qsetNameCounts[safe] ?? 0) + 1;
      for (const q of qs.quantities) {
        const sq = standardNameOrPlaceholder(q.name, 'quantity');
        if (typeof q.name === 'string') authoredQuantityNames.add(q.name);
        qtyNameCounts[sq] = (qtyNameCounts[sq] ?? 0) + 1;
      }
    }
  }
}
const sortedCounts = (obj, n) => Object.fromEntries(
  Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n),
);

const out = {
  bet: 'B5.2',
  pass: 'kernel',
  alias,
  approxMegabytes: coarseMegabytes(bytes.byteLength),
  schemaVersion: schema.schema,
  timings: {
    wasmWarmMs: round(warmMs, 1),
    parseMs: round(parseMs, 1),
    schemaCheckMs: round(schemaMs, 1),
    clashCheckMs: round(clashMs, 1),
    totalMs: round(warmMs + parseMs + schemaMs + clashMs, 1),
  },
  memory: { rssAfterParseMb: rssAfterParse, rssAfterGeometryMb: rssAfterGeometry },
  validate: {
    valid: schema.valid,
    errors: schema.errors,
    warnings: schema.warnings,
    issueCount: schema.issues.length,
    byRule: Object.values(byRule).sort((a, b) => b.count - a.count),
  },
  clash: {
    ok: clash.ok,
    total: clash.total ?? null,
    bySeverity: clash.bySeverity ?? null,
    byRule: clash.byRule ?? null,
    meshedElementCount: clash.meshedElementCount ?? null,
    columnProbes: probeVals.length,
    unmeshedColumns,
    unmeshedColumnPct: probeVals.length > 0 ? round((unmeshedColumns / probeVals.length) * 100, 4) : null,
    // Pair NAMES are authored text; only the shape of the pair list escapes.
    // `clash.pairs` is capped at 50 by clashCheckInProcess, so this is a SAMPLE and
    // is named one: `bySeverity` above is the distribution over every clash.
    sampledPairCount: (clash.pairs ?? []).length,
    sampledPairSeverityHistogram: (clash.pairs ?? []).reduce((h, p) => { h[p.severity] = (h[p.severity] ?? 0) + 1; return h; }, {}),
  },
  gymQuantityReRead: Object.fromEntries(
    Object.entries(gymQuantities).map(([k, v]) => [k, round(v, 6)]),
  ),
  authoredQuantities: {
    elementsChecked,
    elementsWithAnyQset,
    elementsWithoutQset: elementsChecked - elementsWithAnyQset,
    elementsWithAnyQsetPct: elementsChecked > 0 ? round((elementsWithAnyQset / elementsChecked) * 100, 4) : null,
    qsetInstances: standardQsetHits + nonStandardQsetHits,
    standardQsetInstances: standardQsetHits,
    nonStandardQsetInstances: nonStandardQsetHits,
    // `distinctCollapsed*` count labels AFTER standardNameOrPlaceholder, so
    // every non-standard authored name folds into the single `<non-standard>`
    // bucket. `distinctAuthored*` is the count before that fold - the honest
    // measure of the file's vocabulary breadth, emitted as a count only.
    distinctCollapsedQsetLabels: Object.keys(qsetNameCounts).length,
    distinctAuthoredQsetNames: authoredQsetNames.size,
    qsetLabelCounts: sortedCounts(qsetNameCounts, 12),
    distinctCollapsedQuantityLabels: Object.keys(qtyNameCounts).length,
    distinctAuthoredQuantityNames: authoredQuantityNames.size,
    quantityLabelCounts: sortedCounts(qtyNameCounts, 24),
    hasGymQuantities: false, // 'GymQuantities' is non-standard, so it collapses; assert explicitly below
  },
};
out.authoredQuantities.hasGymQuantities = gymQuantities.elementsWithQuantities > 0;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `kernel-${alias}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
