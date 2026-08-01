#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.2 pass 1 of 4: non-identifying descriptors + the benchmark's
 * `heuristic-text` baseline, run verbatim on a foreign model.
 *
 * No kernel, no geometry: this is the cheap pass, and it is the one that
 * scores a PERFECT 1.000 macro-F1 on the synthetic dev split (see
 * tools/world-gym/benchmark/results/leaderboard-dev.json). Running the
 * identical function on a real delivered file is the whole point of the bet:
 * if a regex baseline that is perfect on the corpus fires everywhere on real
 * data, the corpus - not the baseline - is what was being measured.
 *
 * `heuristicPrediction` is imported from the benchmark, unmodified. Nothing
 * in tools/world-gym is touched by this bet.
 *
 * Usage:
 *   node run-text-pass.mjs --model <abs path> --alias model-a \
 *     --tool ifcopenshell --out <dir>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { heuristicPrediction } from '../../../tools/world-gym/benchmark/baselines.mjs';
import { DEFECT_TYPES, QUANTITY_KEYS } from '../../../tools/world-gym/benchmark/splits.mjs';
import { modelId, round } from './lib/model-id.mjs';

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const modelPath = flag('--model');
const alias = flag('--alias');
const tool = flag('--tool', 'unknown');
const outDir = flag('--out');
if (!modelPath || !alias || !outDir) {
  process.stderr.write('Usage: run-text-pass.mjs --model <path> --alias <model-a|model-b> --tool <family> --out <dir>\n');
  process.exit(2);
}

const t0 = performance.now();
const bytes = await readFile(modelPath);
const id = modelId(bytes);
const content = bytes.toString('utf-8');
const tRead = performance.now() - t0;

// --- descriptors (nothing here can carry authored text) --------------------
const DEF_RE = /^#(\d+)=([A-Z0-9_]+)\(/;
const typeCounts = {};
let entityCount = 0;
for (const line of content.split('\n')) {
  const m = DEF_RE.exec(line);
  if (!m) continue;
  entityCount += 1;
  typeCounts[m[2]] = (typeCounts[m[2]] ?? 0) + 1;
}
const schema = /FILE_SCHEMA\(\('([A-Z0-9_]+)'/.exec(content)?.[1] ?? null;

// Product-ish types only, for the element histogram (IfcProduct subtypes we
// can recognise by name without a schema walk). Representation/placement
// entities dominate the raw count and say nothing about the building.
const ELEMENT_TYPES = Object.keys(typeCounts)
  .filter((t) => /^IFC(WALL|SLAB|COLUMN|BEAM|DOOR|WINDOW|SPACE|STAIR|RAILING|ROOF|PLATE|MEMBER|COVERING|CURTAINWALL|FOOTING|PILE|FURNI|BUILDINGELEMENTPROXY|FLOWTERMINAL|FLOWSEGMENT|FLOWFITTING|SITE|BUILDING$|BUILDINGSTOREY|OPENINGELEMENT|SHADINGDEVICE|RAMP|ANNOTATION)/.test(t))
  .sort((a, b) => typeCounts[b] - typeCounts[a]);
const elementHistogram = {};
for (const t of ELEMENT_TYPES) elementHistogram[t] = typeCounts[t];

const tHeur0 = performance.now();
const heuristic = heuristicPrediction(-1, content);
const heuristicMs = performance.now() - tHeur0;

const out = {
  bet: 'B5.2',
  pass: 'text',
  alias,
  modelSha256Prefix: id,
  authoringToolFamily: tool,
  schema,
  bytes: bytes.byteLength,
  megabytes: round(bytes.byteLength / 1e6, 2),
  entityCount,
  distinctEntityTypes: Object.keys(typeCounts).length,
  elementHistogram,
  readMs: round(tRead, 1),
  heuristicMs: round(heuristicMs, 1),
  heuristicPrediction: {
    defects: Object.fromEntries(DEFECT_TYPES.map((t) => [t, heuristic.defects[t]])),
    defectsFired: DEFECT_TYPES.filter((t) => heuristic.defects[t]),
    defectsFiredCount: DEFECT_TYPES.filter((t) => heuristic.defects[t]).length,
    triage: heuristic.triage,
    quantities: Object.fromEntries(QUANTITY_KEYS.map((k) => [k, round(heuristic.quantities[k], 6)])),
  },
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `text-${alias}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
