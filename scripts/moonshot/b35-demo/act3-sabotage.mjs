/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ACT 3 -- SABOTAGE + DETECTION.
 *
 * A sibling seed is force-corrupted (world-gym's corruption layer records
 * every planted defect at plant time -- ground truth by construction), the
 * real check pipeline hunts for the damage, and the benchmark scorer's own
 * oracle path (tools/world-gym/benchmark: seed-regenerated ground truth +
 * the normative scoring functions) scores the detector over a slice of the
 * official dev split.
 *
 * The detector below maps check-pipeline outputs to the 7 benchmark defect
 * verdicts. It mirrors the corpus reward channel's detection mapping
 * (lib/reward-channels.mjs `detectedDefectTypes`, not exported) with one
 * honesty fix: `missing-quantities` is inferred purely from what the bytes
 * show (observed missing minus observed degenerates), never from the
 * plant-time records -- a benchmark submission must not read the answer key.
 * `dangling-ref` is a documented blind spot of `ifc-lite validate`; the
 * detector always answers false there and pays the F1 price in the open.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateModel } from '../../../tools/world-gym/generator.mjs';
import { labelModel } from '../../../tools/world-gym/labeler.mjs';
import { initChecks } from '../../../tools/world-gym/lib/checks.mjs';
import {
  CORRUPT_RATE, DEFECT_TYPES, FAMILY, QUANTITY_KEYS, seedsForSplit,
} from '../../../tools/world-gym/benchmark/splits.mjs';
import { groundTruthForSeed } from '../../../tools/world-gym/benchmark/ground-truth.mjs';
import {
  scoreDefectDetection, scoreQuantityEstimation, scoreValidityTriage,
} from '../../../tools/world-gym/benchmark/score.mjs';
import { OUT_DIR, banner, say } from './util.mjs';

/** Map one labeled line to the 7 benchmark defect verdicts + quantities + triage. */
export function predictionFromLine(line) {
  const issues = line.schemaCheck?.issues ?? [];
  const rules = new Set(issues.map((i) => i.rule));
  const unmeshedProbes = Object.values(line.clash?.probesMeshed ?? {}).filter((meshed) => !meshed).length;
  const q = line.quantitiesExtracted;
  const observedMissingQto = q ? q.quantifiableElements - q.elementsWithQuantities : 0;

  const defects = {
    'clash-pair': (line.clash?.byRule?.['gym-footing-self'] ?? 0) > 0,
    'degenerate-geometry': unmeshedProbes > 0,
    'duplicate-globalid': rules.has('unique-globalid'),
    'missing-site': issues.some((i) => i.rule === 'required-entity' && i.message?.includes('IFCSITE')),
    'multiple-project': rules.has('single-project'),
    'dangling-ref': false, // known validate blind spot, honestly declared
    // Degenerate columns never carried a qset; anything missing beyond them
    // was deleted from the bytes.
    'missing-quantities': observedMissingQto > unmeshedProbes,
  };

  const quantities = {};
  for (const key of QUANTITY_KEYS) quantities[key] = q?.[key] ?? 0;

  const triage = DEFECT_TYPES.filter((t) => defects[t]).length;
  return { seed: line.seed, defects, quantities, triage };
}

export async function runAct3({ seed, devSliceSize = 20 }) {
  banner(3, 'SABOTAGE + DETECTION', 'plant defects in a sibling seed; let the oracle score the hunt');

  await initChecks();

  // -- Spotlight: one force-corrupted sibling of the act-1 seed. ----------
  const spotlightSeed = seed + 1;
  const saboteur = generateModel(spotlightSeed, 'auto', { forceCorrupt: true });
  const filePath = path.join(OUT_DIR, `act3-sabotaged-${spotlightSeed}.ifc`);
  await writeFile(filePath, saboteur.content, 'utf-8');

  const plantedTypes = [...new Set(saboteur.defects.map((d) => d.type))];
  say(`  sibling seed ${spotlightSeed}: ${plantedTypes.length} defect type(s) planted at build time:`);
  for (const d of saboteur.defects) say(`    - ${JSON.stringify(d)}`);

  const line = await labelModel(saboteur, filePath, { engine: 'in-process' });
  const spotlightPrediction = predictionFromLine(line);
  const detectedTypes = DEFECT_TYPES.filter((t) => spotlightPrediction.defects[t]);
  const caught = plantedTypes.filter((t) => detectedTypes.includes(t));
  say(`  pipeline detected: ${detectedTypes.length ? detectedTypes.join(', ') : '(nothing)'}`);
  say(`  caught ${caught.length}/${plantedTypes.length} planted type(s)` +
    (caught.length < plantedTypes.length ? ` (missed: ${plantedTypes.filter((t) => !caught.includes(t)).join(', ')})` : ''));

  // -- Oracle path: score the detector over a dev-split slice. ------------
  const devSeeds = seedsForSplit('dev').slice(0, devSliceSize);
  say(`  scoring the same detector over the first ${devSeeds.length} official dev-split seeds ` +
    `(corrupt rate ${CORRUPT_RATE}, truth regenerated from seeds -- no stored answer key):`);

  const truthBySeed = new Map();
  const lines = new Map();
  let corruptedCount = 0;
  for (const s of devSeeds) {
    truthBySeed.set(s, groundTruthForSeed(s));
    const m = generateModel(s, FAMILY, { corruptRate: CORRUPT_RATE });
    if (m.corrupted) corruptedCount++;
    const l = await labelModel(m, `dev-${s}.ifc`, { engine: 'in-process' });
    lines.set(s, predictionFromLine(l));
  }

  const defectScore = scoreDefectDetection(truthBySeed, lines);
  const quantityScore = scoreQuantityEstimation(truthBySeed, lines);
  const triageScore = scoreValidityTriage(truthBySeed, lines);

  say(`    corrupted models in slice:  ${corruptedCount}/${devSeeds.length}`);
  say(`    defect-detection macro-F1:  ${defectScore.score}`);
  say(`    quantity-estimation score:  ${quantityScore.score}`);
  say(`    validity-triage score:      ${triageScore.score} (0.5 = uninformative)`);

  say('');
  say(`  HEADLINE: sabotage caught ${caught.length}/${plantedTypes.length} on the spotlight model; ` +
    `macro-F1 ${defectScore.score} over ${devSeeds.length} oracle-scored dev seeds`);

  return {
    deterministic: {
      spotlight: {
        seed: spotlightSeed,
        family: saboteur.family,
        sha256: line.sha256,
        plantedDefects: saboteur.defects,
        plantedTypes,
        detectedTypes,
        caughtCount: caught.length,
        plantedCount: plantedTypes.length,
      },
      oracleSlice: {
        split: 'dev',
        seeds: devSeeds,
        corruptedCount,
        defectMacroF1: defectScore.score,
        defectPerType: defectScore.perType,
        quantityScore: quantityScore.score,
        triageScore: triageScore.score,
        triagePairs: triageScore.pairs,
      },
    },
  };
}
