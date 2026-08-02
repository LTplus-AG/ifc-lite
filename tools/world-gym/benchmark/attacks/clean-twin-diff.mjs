#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CLEAN-TWIN-DIFF attack on the World Gym Benchmark (G2 red-team experiment).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * A scored, adversarial submission generator that demonstrates the structural
 * weakness the G2 review flagged: because the corpus generator is public and
 * keyed only by the seed, and because the corruption RNG stream is INDEPENDENT
 * of the family/param streams (generator.mjs uses `${seed}:family`,
 * `${seed}:params:*`, and `${seed}:corrupt` as separate Rng instances), an
 * external adversary can reconstruct, for every evaluated seed:
 *
 *   corruptedBytes = generateModel(seed, 'auto', { corruptRate: 0.3 }).content
 *   cleanBytes     = generateModel(seed, 'auto', { corruptRate: 0    }).content
 *
 * `corruptedBytes` is exactly what a benchmark consumer receives (the episode
 * server / the local `generateModel` call the spec invites submitters to make;
 * BENCHMARK.md section 2: "the model bytes for a seed, which the submitter
 * regenerates locally or receives from the episode server"). `cleanBytes` is
 * the same seed's CLEAN TWIN: because corruption lives on its own RNG stream,
 * turning `corruptRate` to 0 yields a byte-identical building MINUS the planted
 * corruption. A line-level diff of the two therefore isolates *exactly* the
 * corruption, with zero label access.
 *
 * ---------------------------------------------------------------------------
 * WHAT SPEC v1.2 DOES TO IT (B4.3)
 * ---------------------------------------------------------------------------
 * The two `generateModel` calls above are the attack, and they are exactly the
 * step a salt removes: under a salted reporting split the attacker's twins are
 * a different building entirely, so the diff isolates the difference between
 * two unrelated models rather than the planted corruption. This file is NOT
 * weakened for that - it stays committed, unchanged in substance, and is
 * re-run as the regression. It gained one optional salt input (`--salt-env` /
 * `--salt-file`; a salt is never accepted in argv - see lib/salt.mjs), used
 * only by the B4.3 control run to demonstrate that handing the attack the
 * secret restores it to 1.000, i.e. that the collapse is the salt's doing and
 * not a broken harness. Measured numbers: scripts/moonshot/b43-benchmark-salt/.
 *
 * It also keeps working, at full strength, on dev - which is deliberate. Dev is
 * open by design and carries no integrity claim.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS (arguably) LEGAL UNDER THE v1.0 RULES
 * ---------------------------------------------------------------------------
 * BENCHMARK.md section 4, rule 1 forbids exactly two things for the evaluated
 * seed: reading "the corruption layer's plant records" (`model.defects`) or
 * "the generator's internal ground truth" (`model.labels` / `model.expected`).
 * It EXPLICITLY permits "read/mesh/analyze the model bytes".
 *
 * This attack reads ONLY `model.content` (the STEP bytes) from BOTH the
 * corrupted model and the clean twin. It never touches `.defects`,
 * `.expected`, `.labels`, `.params`, or any other generator field. The clean
 * twin is a DIFFERENT model configuration (`corruptRate: 0`), and reading its
 * bytes is "analyzing model bytes" of a model the attacker is free to
 * generate. No answer-key field is ever read. See the `structuralSummary`
 * helper below: it consumes a raw string and returns only byte-derived facts.
 *
 * The label-MAPPING rules (which byte-diff feature means which named defect)
 * are derived from the PUBLIC `lib/corruption.mjs` source, which any attacker
 * can read because the repo is open. Each rule below is annotated with (a) the
 * pure-diff signal and (b) whether naming that signal requires reading the
 * corruption source. This is the whole point of the experiment: the diff
 * itself is label-free; only the human-readable *name* attached to each diff
 * feature leans on the open source.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT
 * ---------------------------------------------------------------------------
 * Writes a submission JSONL (header + one line per split seed) to --out, in
 * the exact format submission.mjs validates. Score it with the REAL pipeline:
 *
 *   node tools/world-gym/benchmark/attacks/clean-twin-diff.mjs \
 *     --split dev --out <scratch>/attack-clean-twin-diff-dev.jsonl
 *   node tools/world-gym/benchmark/score.mjs \
 *     --submission <scratch>/attack-clean-twin-diff-dev.jsonl --split dev
 *
 * Imports are limited to PUBLIC interfaces: generateModel (the consumer's
 * model source) and the split constants. No corruption internals, no
 * ground-truth module, no label field.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { generateModel } from '../../generator.mjs';
import {
  BENCHMARK_NAME, SPEC_VERSION, CORRUPT_RATE, FAMILY, TASK_NAMES,
  DEFECT_TYPES, QUANTITY_KEYS, seedsForSplit,
} from '../splits.mjs';
import { resolveSaltFromArgs, describeSalt, redactSalt } from '../../lib/salt.mjs';

// ============================================================================
// Byte-only structural summary (reads a raw STEP string; no labels involved)
// ============================================================================

const DEF_RE = /^#(\d+)=([A-Z0-9_]+)\(/;

/**
 * Reduce a raw STEP content string to the byte-derived facts the diff needs.
 * This function is deliberately label-blind: its ONLY input is a string, and
 * it never sees any generator field. The same routine runs over the corrupted
 * bytes and over the clean-twin bytes; the attack is entirely in comparing the
 * two summaries.
 */
function structuralSummary(content) {
  const lines = content.split('\n');
  const typeCounts = {};
  const typeById = new Map();
  const guidCounts = new Map();
  const definedIds = new Set();
  const referencedIds = new Set();
  const qsetIds = new Set();              // IfcElementQuantity express ids
  const qtyValueById = new Map();         // quantity line id -> { name, value }
  const qsetQuantityIds = new Map();      // qset id -> [quantity ids]
  const relLines = [];                    // { elementIds, qsetId }
  let boundQsetRelCount = 0;              // RelDefinesByProperties binding a qset

  for (const line of lines) {
    const m = DEF_RE.exec(line);
    if (!m) continue;
    const id = m[1];
    const type = m[2];
    definedIds.add(id);
    typeById.set(id, type);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;

    const body = line.slice(line.indexOf('=') + 1);
    for (const ref of body.match(/#\d+/g) ?? []) referencedIds.add(ref.slice(1));

    // GlobalId scan: first attribute of every rooted entity is a 22-char
    // base64 GlobalId. The length+charset filter keeps ordinary string
    // attributes (quantity names, labels) out of the duplicate count. This
    // mirrors the public heuristic-text baseline's scan.
    const first = /^[A-Z0-9_]+\('([^']+)'/.exec(body)?.[1];
    if (first !== undefined && /^[0-9A-Za-z_$]{22}$/.test(first)) {
      guidCounts.set(first, (guidCounts.get(first) ?? 0) + 1);
    }

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
  // Second pass now that all qset ids are known: count rels that bind a qset.
  for (const r of relLines) if (qsetIds.has(r.qsetId)) boundQsetRelCount++;

  return {
    typeCounts, typeById, guidCounts, definedIds, referencedIds,
    qsetIds, qtyValueById, qsetQuantityIds, relLines, boundQsetRelCount,
  };
}

const count = (summary, type) => summary.typeCounts[type] ?? 0;

// ============================================================================
// Quantity harvest from the CLEAN twin (recovers what missing-quantities hid)
// ============================================================================

/**
 * Sum the embedded GymQuantities of the clean twin into the 5 benchmark keys.
 *
 * This is the quantity lever: the `missing-quantities` defect deletes some
 * quantity bindings from the CORRUPTED bytes, which is exactly why both public
 * baselines (heuristic-text, oracle-kernel) top out at quantity=0.977655 - they
 * read the corrupted file and lose the deleted mass. The clean twin has EVERY
 * binding intact, and lib/quantities.mjs guarantees the embedded per-element
 * GrossVolume / NetFloorArea are the SAME numbers the generator accumulated
 * into labels.totals ("computed once"). So summing the clean twin's embedded
 * quantities reconstructs the quantity-estimation ground truth exactly, with
 * no label access - it is pure byte harvesting of a legally-regenerable model.
 */
function harvestQuantities(cleanSummary) {
  const quantities = {};
  for (const k of QUANTITY_KEYS) quantities[k] = 0;
  const volumeKeyByType = {
    IFCWALL: 'wallGrossVolume',
    IFCSLAB: 'slabGrossVolume',
    IFCCOLUMN: 'columnGrossVolume',
    IFCBEAM: 'beamGrossVolume',
  };
  for (const { elementIds, qsetId } of cleanSummary.relLines) {
    const qids = cleanSummary.qsetQuantityIds.get(qsetId);
    if (!qids) continue;
    for (const elementId of elementIds) {
      const type = cleanSummary.typeById.get(elementId);
      for (const qid of qids) {
        const q = cleanSummary.qtyValueById.get(qid);
        if (!q || !Number.isFinite(q.value)) continue;
        if (q.name === 'GrossVolume' && volumeKeyByType[type]) quantities[volumeKeyByType[type]] += q.value;
        else if (q.name === 'NetFloorArea' && type === 'IFCSPACE') quantities.roomNetFloorArea += q.value;
      }
    }
  }
  return quantities;
}

// ============================================================================
// The diff -> defect verdicts
// ============================================================================

/**
 * Map the clean-vs-corrupted byte diff to the 7 defect verdicts.
 *
 * Every rule is annotated with:
 *   [DIFF]   the label-free byte signal (works with zero corruption-source
 *            knowledge; "something structurally changed between twin and
 *            corrupted").
 *   [NAME]   whether attaching the *named* defect to that signal required
 *            reading the public lib/corruption.mjs source.
 */
function diffDefects(cleanS, corruptS) {
  // R1 clash-pair.
  //   corruption.mjs applyBuildDefects() injects clash pairs as IfcFooting
  //   elements (a type no clean family emits).
  //   [DIFF] corrupted introduces IFCFOOTING lines the clean twin lacks.
  //   [NAME] "these extra footings are the clash injection" comes from the
  //          open corruption source. The diff alone only says "a new element
  //          type appeared out of nowhere".
  const clashPair = count(corruptS, 'IFCFOOTING') > count(cleanS, 'IFCFOOTING');

  // R2 degenerate-geometry.
  //   corruption.mjs injects zero-height IfcColumn elements. The clean twin
  //   shares identical family/params, so its real-column set is identical;
  //   only the injected degenerate columns survive the subtraction.
  //   [DIFF] corrupted has strictly more IFCCOLUMN than the clean twin. Pure
  //          diff - the real columns cancel, the injected ones do not.
  //   [NAME] "the surplus columns are degenerate (extrusion depth 0)" comes
  //          from the corruption source; the count diff needs no such
  //          knowledge.
  const degenerate = count(corruptS, 'IFCCOLUMN') > count(cleanS, 'IFCCOLUMN');

  // R3 duplicate-globalid.
  //   corruption.mjs overwrites the 2nd wall's GlobalId with the 1st wall's.
  //   [DIFF] corrupted contains a GlobalId carried by >1 rooted entity while
  //          the clean twin has all-unique GlobalIds. (Equivalently: some
  //          GUID's corrupted multiplicity exceeds its clean multiplicity.)
  //   [NAME] not required - "a GUID collides" is self-describing and matches
  //          the defect name directly.
  const cleanHasDup = [...cleanS.guidCounts.values()].some((n) => n > 1);
  const corruptHasDup = [...corruptS.guidCounts.values()].some((n) => n > 1);
  const duplicateGlobalId = corruptHasDup && !cleanHasDup;

  // R4 missing-site.
  //   [DIFF] the clean twin has an IFCSITE; the corrupted bytes do not.
  //   [NAME] not required - "the site entity is gone" is self-describing.
  const missingSite = count(cleanS, 'IFCSITE') > count(corruptS, 'IFCSITE');

  // R5 multiple-project.
  //   [DIFF] corrupted has strictly more IFCPROJECT than the clean twin
  //          (which has exactly one).
  //   [NAME] not required - "a second project appeared" is self-describing.
  const multipleProject = count(corruptS, 'IFCPROJECT') > count(cleanS, 'IFCPROJECT');

  // R6 dangling-ref.
  //   corruption.mjs rewrites one real element reference to a non-existent id
  //   (#99999999). This is the defect the kernel's validate cannot see (the
  //   documented gap that makes oracle-kernel score 0 on this type).
  //   The catch: `missing-site` ALSO leaves an undefined reference behind (the
  //   deleted site's id, still referenced by IfcRelAggregates). A raw
  //   undefined-ref scan on the corrupted bytes cannot separate the two.
  //   [DIFF] the clean twin disambiguates: an undefined reference whose target
  //          NEVER EXISTED in the clean twin is an injected dangling ref; an
  //          undefined reference whose target DID exist in clean (i.e. was
  //          deleted) is a deletion side effect, not this defect. So:
  //          exists r referenced-but-undefined in corrupted with r NOT in the
  //          clean twin's defined ids. No hardcoded #99999999 needed - the
  //          twin supplies the "what legitimately existed" oracle for free.
  //   [NAME] not strictly required; the diff yields "a reference points at an
  //          id that was never a real entity", which is the defect itself.
  let danglingRef = false;
  for (const ref of corruptS.referencedIds) {
    if (!corruptS.definedIds.has(ref) && !cleanS.definedIds.has(ref)) { danglingRef = true; break; }
  }

  // R7 missing-quantities.
  //   corruption.mjs deletes IfcRelDefinesByProperties lines that bind
  //   GymQuantities sets. No other defect touches those rels, and the injected
  //   clash/degenerate elements carry no quantity sets, so the bound-qset-rel
  //   count is identical between twin and corrupted EXCEPT for these deletions.
  //   [DIFF] the clean twin binds strictly more quantity sets than corrupted.
  //   [NAME] not required - "quantity bindings were removed" is self-describing.
  const missingQuantities = cleanS.boundQsetRelCount > corruptS.boundQsetRelCount;

  return {
    'clash-pair': clashPair,
    'degenerate-geometry': degenerate,
    'duplicate-globalid': duplicateGlobalId,
    'missing-site': missingSite,
    'multiple-project': multipleProject,
    'dangling-ref': danglingRef,
    'missing-quantities': missingQuantities,
  };
}

// ============================================================================
// Per-seed prediction
// ============================================================================

/**
 * @param {number} seed
 * @param {{ salt?: string }} [opts] - THE ATTACKER'S salt, which is '' in the
 *   attack proper: an adversary does not have the reporting split's secret.
 *   The parameter exists for the B4.3 control run, where the attack is handed
 *   the salt on purpose to show that the harness still works and it is the
 *   secret doing the defending, not a broken attack. Nothing about the attack
 *   is weakened by it - with `salt` omitted this is byte-for-byte the v1.1
 *   attack against the v1.1 corpus.
 */
export function cleanTwinDiffPrediction(seed, opts = {}) {
  const salt = opts.salt ?? '';
  // The corrupted bytes: exactly what a consumer receives for this seed. We
  // read ONLY `.content` - never `.defects`, `.expected`, or `.labels`.
  const corruptContent = generateModel(seed, FAMILY, { corruptRate: CORRUPT_RATE, salt }).content;
  // The clean twin: same seed, corruption disabled. Again ONLY `.content`.
  const cleanContent = generateModel(seed, FAMILY, { corruptRate: 0, salt }).content;

  const corruptS = structuralSummary(corruptContent);
  const cleanS = structuralSummary(cleanContent);

  const defects = diffDefects(cleanS, corruptS);
  const quantities = harvestQuantities(cleanS);
  // Triage: distinct detected defect types = reconstructed ordinal severity.
  // Because the diff is exact, this equals the planted severity, giving a
  // perfect concordance ranking without ever reading the severity label.
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

/**
 * Set once `main` has resolved the salt, so the fatal-error printer at the
 * bottom can scrub it out of anything it is about to write. The attack itself
 * never prints it, but an error path is exactly where a secret escapes.
 */
let RESOLVED_SALT = '';

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const split = getFlag('--split') ?? 'dev';
  const outPath = getFlag('--out');
  const name = getFlag('--name') ?? 'clean-twin-diff';
  // Control only (B4.3): hand the attack the salt it is not supposed to have.
  // Never from argv - `--salt <value>` is refused outright (lib/salt.mjs).
  const salt = resolveSaltFromArgs(args);
  RESOLVED_SALT = salt;
  if (!outPath) {
    process.stderr.write('Usage: node clean-twin-diff.mjs --split dev --out <file.jsonl> [--name <label>] [--salt-env <VAR> | --salt-file <PATH>]\n');
    process.exit(1);
  }

  const seeds = seedsForSplit(split);
  process.stderr.write(
    `CLEAN-TWIN-DIFF attack over split "${split}" (${seeds.length} models, spec ${SPEC_VERSION}, `
    + `${salt ? `${describeSalt(salt)} - control run, not the attack` : 'no salt - the attack proper'})...\n`,
  );

  const predictions = [];
  const t0 = performance.now();
  let done = 0;
  for (const seed of seeds) {
    predictions.push(cleanTwinDiffPrediction(seed, { salt }));
    done++;
    if (done % 100 === 0 || done === seeds.length) {
      process.stderr.write(`  ${done}/${seeds.length} (${((performance.now() - t0) / 1000).toFixed(1)}s)\n`);
    }
  }

  const text = submissionText(name, split, predictions);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, text, 'utf-8');
  process.stderr.write(`Wrote ${predictions.length} predictions -> ${outPath}\n`);
  process.stderr.write('Now score with the REAL pipeline:\n');
  process.stderr.write(`  node tools/world-gym/benchmark/score.mjs --submission ${outPath} --split ${split}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    // A SaltFormatError is an operator message, not a bug: print it without a
    // stack. Everything else prints its stack, scrubbed of the salt.
    const text = err?.name === 'SaltFormatError' ? `error: ${err.message}` : (err.stack ?? err.message);
    process.stderr.write(`${redactSalt(text, RESOLVED_SALT)}\n`);
    process.exit(1);
  });
}
