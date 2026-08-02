/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The five World Gym reward channels, behind one env API (M2: "every
 * shipped check doubles as a reward channel").
 *
 * `computeRewardChannels(line, opts)` maps one manifest line (the labeler's
 * output for one model) to five scalar scores in [0, 1]. With the
 * adversarial corpus half (lib/corruption.mjs) these channels are
 * discriminative - their values genuinely vary across the corpus - instead
 * of the v1 situation where every channel was a constant because every
 * model was valid and clash-free by construction.
 *
 * Channels:
 *
 * 1. `schemaValidity` - graded like `ifc-lite gym`'s schema channel:
 *    1 = valid with no warnings, 0.5 = valid with warnings, 0 = invalid.
 * 2. `clashScore` - 1 / (1 + total detected clashes): 1 when clash-free,
 *    decaying with every detected clash.
 * 3. `determinismHashMatch` - 1 iff the candidate bytes hash to the
 *    manifest's sha256. When no candidate is supplied the model is
 *    REGENERATED from its seed (the corpus's core determinism promise) and
 *    the regenerated hash is compared - so in self-evaluation this channel
 *    doubles as a per-model determinism re-proof. In an agent loop the
 *    candidate is the agent's output and the channel scores exact
 *    byte-level reproduction of the target.
 * 4. `quantityAccuracy` - mean per-quantity agreement between the totals
 *    INDEPENDENTLY RE-EXTRACTED from the serialized bytes and the
 *    generation ground truth: 1 - mean relative error, clamped to [0, 1].
 * 5. `defectDetection` - for corrupted models: the fraction of PLANTED
 *    defect types the check pipeline actually detected (dangling-ref is
 *    currently invisible to `ifc-lite validate`, so models carrying it
 *    score below 1 - a real, deliberately surfaced gap, not a bug in this
 *    channel). For clean models: 1 if the pipeline (correctly) saw
 *    nothing, 0 if it hallucinated a defect. This is the label-integrity /
 *    verifier channel.
 */

import { createHash } from 'node:crypto';
import { generateModel } from '../generator.mjs';

export const CHANNEL_NAMES = [
  'schemaValidity',
  'clashScore',
  'determinismHashMatch',
  'quantityAccuracy',
  'defectDetection',
];

function sha256Of(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function schemaValidityChannel(line) {
  const s = line.schemaCheck;
  if (!s || s.ok === false || s.skipped) return null;
  if (!s.valid) return 0;
  return s.warnings > 0 ? 0.5 : 1;
}

function clashScoreChannel(line) {
  const c = line.clash;
  if (!c || c.ok === false || c.skipped || typeof c.total !== 'number') return null;
  return 1 / (1 + c.total);
}

function determinismChannel(line, candidateContent) {
  const content = candidateContent
    ?? generateModel(line.seed, line.family, { forceCorrupt: line.corrupted }).content;
  return sha256Of(content) === line.sha256 ? 1 : 0;
}

const QUANTITY_KEYS = [
  'wallGrossVolume', 'slabGrossVolume', 'columnGrossVolume', 'beamGrossVolume', 'roomNetFloorArea',
];

function quantityAccuracyChannel(line) {
  const extracted = line.quantitiesExtracted;
  const truth = line.groundTruth?.totals;
  if (!extracted || !truth) return null;
  const errors = [];
  for (const key of QUANTITY_KEYS) {
    const t = truth[key];
    if (typeof t !== 'number' || t <= 0) continue;
    const e = extracted[key] ?? 0;
    errors.push(Math.min(1, Math.abs(e - t) / t));
  }
  if (errors.length === 0) return null;
  const meanErr = errors.reduce((a, b) => a + b, 0) / errors.length;
  return Math.max(0, 1 - meanErr);
}

/** Which planted defect types the check outputs actually show. */
function detectedDefectTypes(line) {
  const detected = new Set();
  const issues = line.schemaCheck?.issues ?? [];
  const rules = new Set(issues.map((i) => i.rule));
  if (rules.has('unique-globalid')) detected.add('duplicate-globalid');
  if (issues.some((i) => i.rule === 'required-entity' && i.message.includes('IFCSITE'))) detected.add('missing-site');
  if (rules.has('single-project')) detected.add('multiple-project');
  const footingClashes = line.clash?.byRule?.['gym-footing-self'] ?? 0;
  if (footingClashes > 0) detected.add('clash-pair');
  const probes = line.clash?.probesMeshed ?? {};
  if (Object.values(probes).some((meshed) => !meshed)) detected.add('degenerate-geometry');
  const q = line.quantitiesExtracted;
  if (q && q.quantifiableElements - q.elementsWithQuantities > (line.expected?.unmeshedElementCount ?? 0)) {
    detected.add('missing-quantities');
  }
  return detected;
}

function defectDetectionChannel(line) {
  if (!line.schemaCheck || line.schemaCheck.skipped || line.schemaCheck.ok === false) return null;
  // Records flagged skipped were planned but never applied to the bytes.
  const planted = [...new Set((line.defects ?? []).filter((d) => !d.skipped).map((d) => d.type))];
  if (planted.length === 0) {
    // Clean model: reward seeing nothing; punish phantom detections.
    const phantom = line.schemaCheck.valid === false || (line.clash?.total ?? 0) > 0;
    return phantom ? 0 : 1;
  }
  const detected = detectedDefectTypes(line);
  const hits = planted.filter((t) => detected.has(t)).length;
  return hits / planted.length;
}

/**
 * The single env API: manifest line in, five scalar reward channels out.
 *
 * @param {object} line - one manifest.jsonl line from the labeler
 * @param {{ candidateContent?: string, skipDeterminism?: boolean }} opts -
 *   candidate bytes for the determinism channel; omitted = regenerate from
 *   seed (self-evaluation / determinism re-proof; costs one in-memory
 *   generation, no checks). skipDeterminism = report null instead of
 *   paying the regeneration (used by corpus-scale reports that re-prove
 *   determinism on a slice instead of every line).
 * @returns {{ schemaValidity, clashScore, determinismHashMatch, quantityAccuracy, defectDetection }}
 */
export function computeRewardChannels(line, opts = {}) {
  return {
    schemaValidity: schemaValidityChannel(line),
    clashScore: clashScoreChannel(line),
    determinismHashMatch: opts.skipDeterminism ? null : determinismChannel(line, opts.candidateContent),
    quantityAccuracy: quantityAccuracyChannel(line),
    defectDetection: defectDetectionChannel(line),
  };
}
