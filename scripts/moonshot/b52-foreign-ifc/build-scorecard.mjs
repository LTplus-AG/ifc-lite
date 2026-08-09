#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.2 scorecard: fold every pass artifact plus the COMMITTED synthetic
 * anchors into one machine-readable file, and compute the delta figures the
 * report quotes. Every numeral in REPORT.md must emit from here or from one of
 * the per-pass artifacts in ./results (see
 * scripts/moonshot/ci/check-report-numerals.mjs).
 *
 * The synthetic scores are READ from tools/world-gym/benchmark/results/, never
 * recomputed: the instrument's committed baselines are the anchor, and a bet
 * that re-derived them would be comparing against its own arithmetic.
 *
 * The per-verdict adjudications encoded in ADJUDICATION below are the one
 * judgement call in this bet. Each carries the artifact field that decides it,
 * so a reviewer can overturn any single line without re-running anything.
 *
 * Nothing is written until the identifier guard at the bottom of this file has
 * passed over both the scorecard and every pass artifact it copies.
 *
 * Usage:
 *   node build-scorecard.mjs --runs <dir with the pass JSONs> [--out <dir>]
 *     [--forbid <name>]... [--forbid-file <path outside this repo>]
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_QSET_NAMES } from './lib/model-id.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const BENCH_RESULTS = join(REPO, 'tools/world-gym/benchmark/results');

// A flag whose value is missing or is itself a flag is an operator mistake, not
// a default. `--out` last on the line used to return undefined and throw a
// TypeError inside join(); `--out --forbid <name>` used to take '--forbid' as
// the output directory AND silently drop the denylist entry that followed it.
function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    process.stderr.write(`${name} needs a value\n`);
    process.exit(2);
  }
  return v;
}
const runsDir = flag('--runs');
const outDir = flag('--out', HERE);
if (!runsDir) {
  process.stderr.write('Usage: build-scorecard.mjs --runs <dir> [--out <dir>]\n');
  process.exit(2);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));
const run = (name) => readJson(join(runsDir, name));
const round = (v, d = 6) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// --- inputs -----------------------------------------------------------------
const leaderboard = readJson(join(BENCH_RESULTS, 'leaderboard-dev.json'));
const splitSummary = readJson(join(BENCH_RESULTS, 'split-summary-dev.json'));
const rowOracle = readJson(join(BENCH_RESULTS, 'row-oracle-kernel-dev.json'));
const rowHeuristic = readJson(join(BENCH_RESULTS, 'row-heuristic-text-dev.json'));

// The anchor filename carries its split; the committed rows above are the dev
// split, so this must be the dev anchor and not whatever ran last.
const anchor = run(`synthetic-anchor-${splitSummary.split}.json`);
const diagSynthetic = run('diagnostics-synthetic.json');

const ALIASES = ['model-a', 'model-b'];
const foreign = {};
for (const a of ALIASES) {
  foreign[a] = {
    text: run(`text-${a}.json`),
    kernel: run(`kernel-${a}.json`),
    oracle: run(`oracle-${a}.json`),
    qto: run(`qto-${a}.json`),
    diagnostics: run(`diagnostics-${a}.json`),
    adjudication: run(`adjudication-${a}.json`),
    cli: run(`cli-${a}.json`),
  };
}

// The kernel pass and the QTO pass mesh the same bytes with the same
// processor, in different processes. Only the QTO pass records the DISTINCT
// element count, so the corpus descriptor below borrows it - which is only
// legitimate while the two passes agree on the mesh population. They agree iff
// the record counts match, so that is asserted rather than assumed.
for (const a of ALIASES) {
  const records = foreign[a].kernel.clash.meshedElementCount;
  const qtoRecords = foreign[a].qto.meshes.total;
  if (records !== qtoRecords) {
    throw new Error(`${a}: kernel meshed ${records} records, QTO pass meshed ${qtoRecords}; `
      + 'the two passes did not see the same geometry, so distinctElements cannot describe the kernel run');
  }
  if (foreign[a].qto.meshes.distinctElements > records) {
    throw new Error(`${a}: distinctElements (${foreign[a].qto.meshes.distinctElements}) exceeds mesh records (${records})`);
  }
}

// ---------------------------------------------------------------------------
// The adjudication table. One row per POSITIVE verdict any detector produced on
// any foreign model. `verdict` is the call this bet makes; `decidedBy` names
// the artifact field that decides it.
// ---------------------------------------------------------------------------
const ADJUDICATION = [
  {
    model: 'model-a', detector: 'heuristic-text', defect: 'missing-quantities', verdict: 'false-positive',
    rule: 'some IfcElementQuantity is not bound by an IfcRelDefinesByProperties',
    decidedBy: 'adjudication.quantityBinding.heuristicRegexCoveragePct = 0 while orphanQuantitySets = 0',
    reading: "the baseline's IfcRelDefinesByProperties regex matched none of this exporter's relationship lines, so every quantity set looked unbound; the file in fact binds all of them",
  },
  {
    model: 'model-b', detector: 'heuristic-text', defect: 'clash-pair', verdict: 'false-positive',
    rule: 'IFCFOOTING count > 0',
    decidedBy: 'adjudication.footings.footingSelfClashesFound = 0 against ifcFootingCount = 16',
    reading: 'the rule treats the mere existence of a footing as a clash; the clash engine finds no overlapping footing pair in this model',
  },
  {
    model: 'model-b', detector: 'heuristic-text', defect: 'duplicate-globalid', verdict: 'false-positive',
    rule: 'any repeated 22-character base64 first attribute',
    decidedBy: 'adjudication.globalIdScan.entitiesInDuplicateGroupsByEntityType is entirely IFCPROPERTYSINGLEVALUE, with kernelUniqueGlobalIdErrors = 0',
    reading: 'the repeated string is a property NAME on a non-rooted entity, not a GlobalId; nothing in the file has a duplicate GlobalId',
  },
  {
    model: 'model-a', detector: 'oracle-kernel', defect: 'missing-quantities', verdict: 'false-positive',
    rule: 'quantifiableElements - elementsWithQuantities > unmeshedColumns, over the pset literally named GymQuantities',
    decidedBy: 'kernel.authoredQuantities.elementsWithAnyQsetPct = 99.0507 while gymQuantityReRead.elementsWithQuantities = 0',
    reading: 'no file authored outside this program can carry a pset named GymQuantities, so this verdict fires on every foreign model by construction',
  },
  {
    model: 'model-b', detector: 'oracle-kernel', defect: 'missing-quantities', verdict: 'false-positive',
    rule: 'quantifiableElements - elementsWithQuantities > unmeshedColumns, over the pset literally named GymQuantities',
    decidedBy: 'kernel.authoredQuantities.elementsWithAnyQsetPct = 98.892 while gymQuantityReRead.elementsWithQuantities = 0',
    reading: 'same structural miss as model-a',
  },
  {
    model: 'model-a', detector: 'oracle-kernel', defect: 'degenerate-geometry', verdict: 'true-signal-wrong-label',
    rule: 'at least one IfcColumn produced no mesh',
    decidedBy: 'adjudication.unmeshedColumns.unmeshedRepresentationIdentifierAndType plus unmeshedMappedTargetIdentifierAndType (see foreignDefectSignal.degenerateGeometryModelA.evidenceState)',
    reading: 'filled in from the artifact at build time (see foreignDefectSignal.degenerateGeometryModelA)',
  },
];

/**
 * Three verdict classes, not two. A positive that points at nothing wrong is a
 * false positive. A positive that points at a real property of the file but
 * NOT at the defect type it claims is neither - collapsing it into either
 * bucket would overstate the result in one direction or the other, so it gets
 * its own class and the report quotes both precisions.
 */
const VERDICT_CLASSES = ['false-positive', 'true-positive', 'true-signal-wrong-label'];

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------
const DEFECT_TYPES = ['clash-pair', 'degenerate-geometry', 'duplicate-globalid', 'missing-site', 'multiple-project', 'dangling-ref', 'missing-quantities'];

// Every synthetic-side figure the report compares the foreign result against
// is derived HERE from the committed rows, never restated. A restated constant
// is a figure that stops tracking its source the moment the source moves, and
// the whole comparison in this bet is synthetic-versus-foreign.
const perType = (row, t) => row.detail['defect-detection'].perType[t];
const sumOverTypes = (row, field) => DEFECT_TYPES.reduce((s, t) => s + perType(row, t)[field], 0);
const syntheticTotalTp = sumOverTypes(rowHeuristic, 'tp') + sumOverTypes(rowOracle, 'tp');
const syntheticTotalFp = sumOverTypes(rowHeuristic, 'fp') + sumOverTypes(rowOracle, 'fp');
const syntheticTotalPositives = syntheticTotalTp + syntheticTotalFp;

const verdictMatrix = {};
for (const a of ALIASES) {
  verdictMatrix[a] = {
    'heuristic-text': foreign[a].text.heuristicPrediction.defects,
    'oracle-kernel': foreign[a].oracle.prediction.defects,
  };
}
let positiveVerdicts = 0;
let totalVerdicts = 0;
for (const a of ALIASES) {
  for (const d of ['heuristic-text', 'oracle-kernel']) {
    for (const t of DEFECT_TYPES) {
      totalVerdicts += 1;
      if (verdictMatrix[a][d][t]) positiveVerdicts += 1;
    }
  }
}
const falsePositiveVerdicts = ADJUDICATION.filter((r) => r.verdict === 'false-positive').length;
const truePositiveVerdicts = ADJUDICATION.filter((r) => r.verdict === 'true-positive').length;
const wrongLabelVerdicts = ADJUDICATION.filter((r) => r.verdict === 'true-signal-wrong-label').length;
if (ADJUDICATION.some((r) => !VERDICT_CLASSES.includes(r.verdict))) {
  throw new Error('adjudication row carries an unknown verdict class');
}
if (ADJUDICATION.length !== positiveVerdicts) {
  throw new Error(`adjudication table has ${ADJUDICATION.length} rows for ${positiveVerdicts} positive verdicts`);
}

const medianOracleMs = anchor.oracleMsPerModel.median;
const medianHeuristicMs = anchor.heuristicMsPerModel.median;
const medianEntityCount = anchor.entityCount.median;
const medianBytes = anchor.fileBytes.median;

const scaleRow = (a) => ({
  alias: a,
  entityCount: foreign[a].text.entityCount,
  entityCountVsSyntheticMedian: round(foreign[a].text.entityCount / medianEntityCount, 1),
  bytes: foreign[a].text.bytes,
  bytesVsSyntheticMedian: round(foreign[a].text.bytes / medianBytes, 1),
  oracleMs: foreign[a].oracle.oracleMs,
  oracleMsVsSyntheticMedian: round(foreign[a].oracle.oracleMs / medianOracleMs, 1),
  heuristicMs: foreign[a].text.heuristicMs,
  heuristicMsVsSyntheticMedian: round(foreign[a].text.heuristicMs / medianHeuristicMs, 1),
  // Sampled at pass exit, not a high-water mark - see run-oracle-pass.mjs.
  oracleRssAtExitMb: foreign[a].oracle.rssAtExitMb,
  // Cost per entity is the scale-normalised comparison: it says whether the
  // instrument merely met a bigger file or got worse per unit of work.
  oracleUsPerEntity: round((foreign[a].oracle.oracleMs * 1000) / foreign[a].text.entityCount, 3),
});

const syntheticOracleUsPerEntity = round((medianOracleMs * 1000) / medianEntityCount, 3);

const openings = {
  synthetic: {
    sampledModels: diagSynthetic.sampledModels,
    total: diagSynthetic.diagnostics.classification.total,
    rectangular: diagSynthetic.diagnostics.classification.rectangular,
    diagonal: diagSynthetic.diagnostics.classification.diagonal,
    nonRectangular: diagSynthetic.diagnostics.classification.nonRectangular,
    rectangularPct: round((diagSynthetic.diagnostics.classification.rectangular / diagSynthetic.diagnostics.classification.total) * 100, 4),
    rectFastFired: diagSynthetic.diagnostics.rectFast.fired,
    rectFastOpeningsCut: diagSynthetic.diagnostics.rectFast.openingsCut,
    rectFastDeferrals: diagSynthetic.diagnostics.rectFast.deferHostNotBox + diagSynthetic.diagnostics.rectFast.deferNotThrough
      + diagSynthetic.diagnostics.rectFast.deferOffFace + diagSynthetic.diagnostics.rectFast.deferNearEdge,
    totalCsgFailures: diagSynthetic.diagnostics.totalCsgFailures,
    silentNoOps: diagSynthetic.diagnostics.silentNoOps,
    openingsCutByFastPathPct: round((diagSynthetic.diagnostics.rectFast.openingsCut / diagSynthetic.diagnostics.classification.total) * 100, 4),
  },
};
for (const a of ALIASES) {
  const d = foreign[a].diagnostics.diagnostics;
  openings[a] = {
    total: d.classification.total,
    rectangular: d.classification.rectangular,
    diagonal: d.classification.diagonal,
    nonRectangular: d.classification.nonRectangular,
    rectangularPct: d.classification.total > 0 ? round((d.classification.rectangular / d.classification.total) * 100, 4) : null,
    hostsWithOpenings: d.hostsWithOpenings,
    rectFastFired: d.rectFast.fired,
    rectFastOpeningsCut: d.rectFast.openingsCut,
    rectFastDeferrals: d.rectFast.deferHostNotBox + d.rectFast.deferNotThrough + d.rectFast.deferOffFace + d.rectFast.deferNearEdge,
    totalCsgFailures: d.totalCsgFailures,
    productsWithFailures: d.productsWithFailures,
    failuresByReason: d.failuresByReason,
    silentNoOps: d.silentNoOps,
    openingsCutByFastPathPct: d.classification.total > 0 ? round((d.rectFast.openingsCut / d.classification.total) * 100, 4) : null,
  };
}

const quantity = {
  syntheticTaskScore: rowOracle.scores['quantity-estimation'],
  syntheticTaskNote: 'plant-time ground truth; the prediction is a re-read of the same GymQuantities literals the generator embedded, so it measures round-trip fidelity of numbers, not geometry',
  foreignNote: 'authored IfcElementQuantity NetVolume as truth, kernel mesh volume as prediction, scored with the identical score.mjs expression; this measures the geometry kernel against an independently authored reference',
};
for (const a of ALIASES) {
  const q = foreign[a].qto;
  quantity[a] = {
    pairedElements: q.overall.pairedElements,
    meanElementScore: q.overall.meanElementBenchScore,
    medianElementScore: q.overall.medianElementBenchScore,
    within1PctOfPairedPct: q.overall.within1PctOfPairedPct,
    within5PctOfPairedPct: q.overall.within5PctOfPairedPct,
    zeroScoreCount: q.overall.zeroScoreCount,
    modelTotalBenchScore: q.overall.modelTotalBenchScore,
    buildingElementParts: q.meshes.buildingElementParts,
    buildingElementPartsWithMesh: q.meshes.buildingElementPartsWithMesh,
    perGroup: Object.fromEntries(Object.entries(q.groups)
      .filter(([, g]) => g.pairedElements > 0)
      .map(([k, g]) => [k, {
        pairedElements: g.pairedElements,
        meshCoveragePct: g.meshCoveragePct,
        meanElementBenchScore: g.meanElementBenchScore,
        modelTotalBenchScore: g.modelTotalBenchScore,
      }])),
    deltaVsSyntheticTaskScore: round(q.overall.meanElementBenchScore - rowOracle.scores['quantity-estimation'], 6),
    benchmarkKeyQuantitiesPredicted: foreign[a].oracle.prediction.quantityKeysNonZero,
    authoredQsetCoveragePct: foreign[a].kernel.authoredQuantities.elementsWithAnyQsetPct,
  };
}

const degenA = foreign['model-a'].adjudication.unmeshedColumns;
const foreignDefectSignal = {
  degenerateGeometryModelA: {
    totalColumns: degenA.totalColumns,
    unmeshedColumns: degenA.unmeshedColumns,
    unmeshedPct: degenA.unmeshedPct,
    declaringRepresentation: degenA.unmeshedDeclaringRepresentation,
    declaringNoRepresentation: degenA.unmeshedDeclaringNoRepresentation,
    representationIdentifierAndType: degenA.unmeshedRepresentationIdentifierAndType ?? {},
    representationItemTypes: degenA.unmeshedRepresentationItemTypes ?? {},
  },
};

const scorecard = {
  bet: 'B5.2',
  title: 'Foreign IFC: the World Gym benchmark and its defect detector on two real delivered models',
  instrument: {
    note: 'nothing under tools/world-gym was modified by this bet; every check is the committed function, imported',
    benchmark: leaderboard.benchmark,
    specVersion: leaderboard.specVersion,
  },
  corpus: {
    synthetic: {
      split: splitSummary.split,
      models: splitSummary.models,
      clean: splitSummary.clean,
      corrupted: splitSummary.corrupted,
      corruptRate: splitSummary.corruptRate,
      entityCountMedian: splitSummary.entityCountDistribution.median,
      entityCountMax: splitSummary.entityCountDistribution.max,
      committedRows: Object.fromEntries(leaderboard.rows.map((r) => [r.name, r.scores])),
      resample: {
        sampledModels: anchor.sampledModels,
        cleanModels: anchor.cleanModels,
        corruptedModels: anchor.corruptedModels,
        entityCount: anchor.entityCount,
        fileBytes: anchor.fileBytes,
        oracleMsPerModel: anchor.oracleMsPerModel,
        heuristicMsPerModel: anchor.heuristicMsPerModel,
        falsePositives: anchor.falsePositives,
        referenceIntegrityProbe: anchor.referenceIntegrityProbe,
      },
    },
    foreign: ALIASES.map((a) => ({
      alias: a,
      modelSha256Prefix: foreign[a].text.modelSha256Prefix,
      authoringToolFamily: foreign[a].text.authoringToolFamily,
      schema: foreign[a].text.schema,
      bytes: foreign[a].text.bytes,
      megabytes: foreign[a].text.megabytes,
      entityCount: foreign[a].text.entityCount,
      distinctEntityTypes: foreign[a].text.distinctEntityTypes,
      elementHistogram: foreign[a].text.elementHistogram,
      // `clashCheckInProcess` returns `meshedElementCount: meshes.length`, and
      // an element with several material or submesh records contributes one
      // entry per record. On model-b that is 77,290 records against 22,634
      // distinct express ids - a 3.4x inflation if the field is read as an
      // element count, which is what its name invites. Both are published, each
      // named for what it is. The distinct count comes from the QTO pass, which
      // meshes the same bytes with the same processor (its `meshes.total`
      // equals this `meshRecordCount` on both models, which is what makes the
      // two artifacts comparable at all).
      meshRecordCount: foreign[a].kernel.clash.meshedElementCount,
      distinctMeshedElements: foreign[a].qto.meshes.distinctElements,
      totalTriangles: foreign[a].qto.meshes.totalTriangles,
    })),
  },
  validity: {
    note: 'the exam asked for ifc-lite validate and the clash engine on foreign input; both ran clean',
    ...Object.fromEntries(ALIASES.map((a) => [a, {
      inProcess: {
        valid: foreign[a].kernel.validate.valid,
        errors: foreign[a].kernel.validate.errors,
        warnings: foreign[a].kernel.validate.warnings,
        issueCount: foreign[a].kernel.validate.issueCount,
        byRule: foreign[a].kernel.validate.byRule,
      },
      cli: foreign[a].cli.validate,
      clash: {
        total: foreign[a].kernel.clash.total,
        byRule: foreign[a].kernel.clash.byRule,
        cliSummaryTotal: foreign[a].cli.clash?.summary?.total ?? null,
        cliWallMs: foreign[a].cli.clash?.wallMs ?? null,
      },
    }])),
  },
  defectDetection: {
    syntheticMacroF1: {
      'heuristic-text': rowHeuristic.scores['defect-detection'],
      'oracle-kernel': rowOracle.scores['defect-detection'],
    },
    syntheticFalsePositives: {
      note: 'committed dev row, 1,000 models, per-type fp counts',
      'heuristic-text': Object.fromEntries(DEFECT_TYPES.map((t) => [t, perType(rowHeuristic, t).fp])),
      'oracle-kernel': Object.fromEntries(DEFECT_TYPES.map((t) => [t, perType(rowOracle, t).fp])),
      heuristicTotalFp: sumOverTypes(rowHeuristic, 'fp'),
      oracleTotalFp: sumOverTypes(rowOracle, 'fp'),
      heuristicTotalTp: sumOverTypes(rowHeuristic, 'tp'),
      oracleTotalTp: sumOverTypes(rowOracle, 'tp'),
      // The comparable denominator: every boolean either detector emitted over
      // the whole split. models x 7 defect types x 2 detectors.
      totalVerdicts: splitSummary.models * DEFECT_TYPES.length * 2,
      positiveVerdicts: syntheticTotalPositives,
    },
    foreignVerdictMatrix: verdictMatrix,
    foreignVerdictCounts: {
      models: ALIASES.length,
      detectors: 2,
      defectTypes: DEFECT_TYPES.length,
      totalVerdicts,
      positiveVerdicts,
      negativeVerdicts: totalVerdicts - positiveVerdicts,
      adjudicatedFalsePositives: falsePositiveVerdicts,
      adjudicatedTruePositives: truePositiveVerdicts,
      adjudicatedTrueSignalWrongLabel: wrongLabelVerdicts,
      // Strict: a positive counts only if it named the right defect type.
      labelPrecisionOnForeignPct: positiveVerdicts > 0 ? round((truePositiveVerdicts / positiveVerdicts) * 100, 4) : null,
      // Lenient: a positive counts if it pointed at anything real in the file.
      anySignalPrecisionOnForeignPct: positiveVerdicts > 0
        ? round(((truePositiveVerdicts + wrongLabelVerdicts) / positiveVerdicts) * 100, 4) : null,
      falsePositiveShareOfPositivesPct: positiveVerdicts > 0 ? round((falsePositiveVerdicts / positiveVerdicts) * 100, 4) : null,
      falsePositivesPerModel: round(falsePositiveVerdicts / ALIASES.length, 4),
      // Derived from the committed rows, not restated: this is the figure the
      // report's "100% -> 0%" headline is measured against.
      syntheticLabelPrecisionPct: syntheticTotalPositives > 0
        ? round((syntheticTotalTp / syntheticTotalPositives) * 100, 4) : null,
      syntheticFalsePositivesOver1000Models: syntheticTotalFp,
    },
    adjudication: ADJUDICATION,
    structurallyImpossibleOnForeignData: [
      {
        detector: 'oracle-kernel', defect: 'missing-quantities',
        why: 'the verdict is computed over quantities re-read from a pset literally named GymQuantities, which only this program\'s generator writes; on any foreign file elementsWithQuantities is 0 and the verdict is true whenever the model has more quantifiable elements than unmeshed columns',
      },
      {
        detector: 'heuristic-text', defect: 'clash-pair',
        why: 'the verdict is `IFCFOOTING count > 0`; the corpus only emits footings as an injected defect, so on any real file with foundations it fires unconditionally',
      },
      {
        detector: 'oracle-kernel', defect: 'dangling-ref',
        why: 'hardcoded false in baselines.mjs; see referenceIntegrityGap - the kernel rule it says is missing exists and detects 100% of the corpus\'s own planted dangling references',
      },
    ],
  },
  referenceIntegrityGap: {
    note: "baselines.mjs oraclePrediction hardcodes dangling-ref:false with the comment 'The kernel's validate has no reference-integrity rule'. computeValidationIssues has had one; this measures whether it fires.",
    modelsWithPlantedDanglingRef: anchor.referenceIntegrityProbe.modelsWithPlantedDanglingRef,
    modelsWhereValidateFlaggedReferenceIntegrity: anchor.referenceIntegrityProbe.modelsWhereValidateFlaggedReferenceIntegrity,
    detectionPct: anchor.referenceIntegrityProbe.detectionPct,
    committedOracleDefectF1: rowOracle.scores['defect-detection'],
    committedOracleDanglingRefF1: perType(rowOracle, 'dangling-ref').f1,
    committedOracleDanglingRefFn: perType(rowOracle, 'dangling-ref').fn,
    // Macro-F1 recomputed from the committed per-type scores with ONLY the
    // dangling-ref term replaced by 1. The previous form assumed the other six
    // types were all perfect and would have kept reporting 1 if one of them
    // regressed - which is exactly the claim this figure is being used to make.
    oracleDefectF1IfWired: round(
      DEFECT_TYPES.reduce((s, t) => s + (t === 'dangling-ref' ? 1 : perType(rowOracle, t).f1), 0) / DEFECT_TYPES.length,
      6,
    ),
    consequence: 'the leaderboard\'s "deliberately not perfect" upper bound is understated by one whole type; wiring the existing rule would put oracle-kernel at parity with heuristic-text, i.e. BOTH anchors saturate the defect task',
  },
  quantityEstimation: quantity,
  openingsAndCsg: {
    note: 'the geometry kernel\'s own typed diagnostics contract, which no benchmark task consumes',
    ...openings,
    delta: {
      syntheticNonRectangularOpenings: openings.synthetic.nonRectangular,
      syntheticDiagonalOpenings: openings.synthetic.diagonal,
      syntheticCsgFailures: openings.synthetic.totalCsgFailures,
      foreignCsgFailures: openings['model-a'].totalCsgFailures + openings['model-b'].totalCsgFailures,
      foreignNonRectangularOpenings: openings['model-a'].nonRectangular + openings['model-b'].nonRectangular,
      foreignDiagonalOpenings: openings['model-a'].diagonal + openings['model-b'].diagonal,
      foreignSilentNoOps: openings['model-a'].silentNoOps + openings['model-b'].silentNoOps,
      reading: 'the corpus exercises exactly one opening class and the rect_fast fast path takes 100% of it, so the general CSG path - where every foreign failure lives - is never entered by the benchmark',
    },
  },
  scale: {
    syntheticMedianEntityCount: medianEntityCount,
    syntheticMedianBytes: medianBytes,
    syntheticMedianOracleMs: medianOracleMs,
    syntheticMedianHeuristicMs: medianHeuristicMs,
    syntheticOracleUsPerEntity,
    foreign: ALIASES.map(scaleRow),
  },
  foreignDefectSignal,
  notMeasured: [
    'validity-triage cannot be scored on foreign models: the task is a concordance index against planted severity, and a delivered file has no planted severity. Predicted triage values are reported; no score is.',
    'defect-detection cannot be scored as macro-F1 on foreign models for the same reason. What is reported instead is the per-verdict adjudication, which is the strongest claim two files support.',
    'the benchmark\'s roomNetFloorArea key has no mesh-side estimator in the kernel geometry output, so the fifth quantity key is unmeasured on foreign data rather than approximated.',
    'two models is not a sample. Every foreign figure here is a case study, and the per-model spread between model-a and model-b is the only variance estimate this bet has.',
    'the two foreign models are both IFC4 and neither is a Revit or Tekla export, so the plan\'s "at least one file exported from Revit or Tekla" clause is NOT satisfied by this run.',
  ],
};

// Backfill the one adjudication row whose reading depends on the artifact.
// Selected by BOTH defect and model: `degenA` is model-a's artifact, so a
// find() on the defect alone would silently write model-a's numbers onto a
// model-b row the day one is added. Missing row is fatal, not a null deref.
const degRow = ADJUDICATION.find((r) => r.defect === 'degenerate-geometry' && r.model === 'model-a');
if (!degRow) throw new Error('adjudication table lost the model-a degenerate-geometry row');
const repKeys = Object.keys(degenA.unmeshedRepresentationIdentifierAndType ?? {});
const targetKeys = Object.keys(degenA.unmeshedMappedTargetIdentifierAndType ?? {});
// "Every unmeshed column declares a Representation, and none of them carries a
// body" is two claims. The first is only true when no unmeshed column declared
// nothing at all, so it is asserted rather than assumed.
const allDeclare = repKeys.length > 0 && degenA.unmeshedDeclaringNoRepresentation === 0;

// The SECOND claim is where this used to overstate. It tested only the
// RepresentationIdentifier prefix (`Body/`), but the identifier is not what
// ifc-lite's geometry router reads: rep_filter.rs::effective_rep_type prefers
// the RepresentationType (attribute 2) and falls back to the identifier, and
// `is_body_representation` counts `MappedRepresentation` as BODY - explicitly,
// because its IfcMappedItem can expand to real solids. So a column whose only
// representation is `Axis/MappedRepresentation` is one the kernel entered as
// body geometry and got nothing from. Whether "the file ships columns with no
// solid geometry" or "the kernel failed to expand a mapping" is the true
// reading is decided by what the mapping TARGETS, which the first version of
// this probe never followed (see run-adjudication-pass.mjs). Three states, not
// two: proven bodyless, proven body-behind-a-mapping, or unresolved.
const MAPPED = 'MappedRepresentation';
// rust/geometry/src/router/rep_filter.rs::is_body_representation, transcribed.
// Kept as a literal copy rather than paraphrased so a reviewer can diff it.
const BODY_REP_TYPES = new Set([
  'Body', 'SweptSolid', 'Brep', 'CSG', 'Clipping', 'Tessellation',
  MAPPED, 'SolidModel', 'SurfaceModel', 'Surface3D', 'AdvancedSweptSolid',
  'AdvancedBrep',
]);
// effective_rep_type: RepresentationType when non-blank, else the identifier.
// The keys here are `identifier/type` with `(unset)` for an absent attribute.
const effectiveType = (key) => {
  const [ident, rtype] = key.split('/');
  return rtype && rtype !== '(unset)' ? rtype : ident;
};
const anyMapped = repKeys.some((k) => effectiveType(k) === MAPPED);
const bodyIdentifier = repKeys.some((k) => k.startsWith('Body/'));
// A DIRECT (non-mapped) body on the far side of the mapping.
const targetHasBody = targetKeys.some((k) => {
  const t = effectiveType(k);
  return t !== MAPPED && BODY_REP_TYPES.has(t);
});
let degenState;
if (!allDeclare) degenState = 'mixed';
else if (bodyIdentifier) degenState = 'declares-body';
else if (anyMapped && targetKeys.length === 0) degenState = 'mapping-not-followed';
else if (anyMapped && targetHasBody) degenState = 'body-behind-mapping';
else degenState = 'bodyless';

const WRONG_LABEL_TAIL = 'Either way the verdict points at something real in the file and names a defect type that is not what is there ("degenerate-geometry" is planted in the corpus as a zero-depth extrusion), so the class is true-signal-wrong-label under both readings.';
const READINGS = {
  mixed: () => `${degenA.unmeshedDeclaringNoRepresentation} of the ${degenA.unmeshedColumns} unmeshed columns declare no Representation at all; the remaining ${degenA.unmeshedDeclaringRepresentation} declare ${repKeys.length > 0 ? repKeys.join(', ') : 'no shape representation this probe could read'}. ${WRONG_LABEL_TAIL}`,
  'declares-body': () => `every one of the ${degenA.unmeshedColumns} unmeshed columns declares a Representation and at least one of them declares a Body: the set is ${repKeys.join(', ')}. A declared Body that produced no mesh is a kernel finding, not a property of the file. ${WRONG_LABEL_TAIL}`,
  'mapping-not-followed': () => `every one of the ${degenA.unmeshedColumns} unmeshed columns declares a Representation, and the whole declared set is ${repKeys.join(', ')} - no Body IDENTIFIER. That is as far as this artifact goes: the RepresentationType is ${MAPPED}, which ifc-lite's own canonical predicate (rep_filter.rs::is_body_representation) counts as body geometry, and the probe that produced this artifact did not follow the mapping. So the file declares no Body-identified shape on these columns, and whether the mapping targets a solid the kernel failed to expand is NOT established here. ${WRONG_LABEL_TAIL}`,
  'body-behind-mapping': () => `every one of the ${degenA.unmeshedColumns} unmeshed columns declares a Representation; the declared set is ${repKeys.join(', ')}, and following the mapping reaches ${targetKeys.join(', ')} - a body. The kernel had solid geometry to expand and produced none, which is a kernel finding rather than a property of the file. ${WRONG_LABEL_TAIL}`,
  bodyless: () => `every one of the ${degenA.unmeshedColumns} unmeshed columns declares a Representation, but none of those representations carries a body: the declared set is ${repKeys.join(', ')}${targetKeys.length > 0 ? `, and following the mapping reaches ${targetKeys.join(', ')}` : ''}. So the kernel is right to produce no mesh and the file really does ship columns with no solid geometry. ${WRONG_LABEL_TAIL}`,
};
degRow.reading = READINGS[degenState]();
degRow.evidenceState = degenState;
foreignDefectSignal.degenerateGeometryModelA.evidenceState = degenState;
foreignDefectSignal.degenerateGeometryModelA.mappedTargetIdentifierAndType = degenA.unmeshedMappedTargetIdentifierAndType ?? {};

// ---------------------------------------------------------------------------
// THE IDENTIFIER GUARD.
//
// Everything above this line composes an artifact out of whatever the pass
// JSONs happened to contain and, until now, wrote it unchecked. B5.5's runner
// asserts over its own output before writing; this build asserted nothing, and
// that is the entire structural difference between the bet that leaked
// authored text into a committed file and the bet that did not. So the
// assertion lives here, and it runs over the scorecard AND over every results
// file this script copies, because the leak was in both.
//
// WHAT IT REJECTS IS NAMES, NOT MEASUREMENTS. Exact byte counts, exact entity
// counts, counted histograms and sha256 prefixes are published deliberately -
// the claim this bet makes is "measured on real files", and a bucketed figure
// is a weaker version of that claim, not a safer one. There is therefore no
// rule below about magnitude, precision or uniqueness. What must never appear
// is a real FILE NAME or a person / organisation / project name.
//
// Three rules, in the order they fire:
//
//  1. FILE NAMES AND PATHS, by shape. Any token carrying a model or CAD file
//     extension, and any absolute or home-relative filesystem path. This needs
//     no knowledge of what the two source files are actually called - which
//     matters, because a denylist that spelled them out would itself be the
//     leak it exists to prevent.
//
//  2. AUTHORED STRINGS, by closed vocabulary at the points they can enter.
//     Every map in this artifact set whose KEYS are text the file authored is
//     listed with the vocabulary those keys must come from. A storey, site or
//     organisation name fails the pattern that `IFCWALL`, `BaseQuantities` or
//     `quantity-completeness/info` passes. Maps that are keyed by authored text
//     with no safe vocabulary at all (`byStorey`, the one run-cli-pass used to
//     copy wholesale) map to null and are rejected on sight. A key name that
//     looks like a map and is NOT listed is also rejected, so an open-ended map
//     added upstream fails closed rather than shipping.
//
//  3. AN OPERATOR DENYLIST, for the names no shape rule can know: the client,
//     the firm, the project, the two source file names. Supplied at run time
//     via --forbid <string> (repeatable) or --forbid-file <path>, both read
//     from OUTSIDE this repository. Writing them into this file would publish
//     exactly what they exist to suppress.
// ---------------------------------------------------------------------------

/** Model / CAD file extensions. A basename carrying one of these is a file name. */
const MODEL_FILE_RE = /[^\s"'`]*\.(?:ifc|ifczip|ifcxml|ifcjson|rvt|rfa|rte|pln|plc|dwg|dxf|dgn|skp|nwd|nwc|3dm|stp|step|sat)\b/i;

/** Absolute or home-relative filesystem paths, on either platform. */
const FS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\]|~\/|\/(?:Users|home|Volumes|mnt|media|Documents|Desktop|Downloads)\/)/;

/**
 * Maps whose KEYS are, or could be, text the source file authored. The value is
 * the vocabulary a key is allowed to come from - a RegExp, or a Set of literal
 * names for a closed vocabulary. `null` means the map itself must never reach
 * an artifact.
 */
const KEYED_BY_AUTHORED_TEXT = new Map([
  ['elementHistogram', /^IFC[A-Z0-9]+$/],
  // `duplicateTypeCounts` counts one entry per ENTITY, not per group; the
  // artifact field is named for that. The pre-rename spelling stays listed
  // because the committed run emitted it and the guard runs over that record.
  ['entitiesInDuplicateGroupsByEntityType', /^IFC[A-Z0-9]+$/],
  ['duplicateGroupsByEntityType', /^IFC[A-Z0-9]+$/],
  // Emitted as a `{ rule, severity, count }` array by every pass here; the
  // pattern covers the map form the CLI can also produce.
  ['byRule', /^[a-z0-9-]+$/],
  ['byTypePair', /^IFC[A-Z0-9]+\s*[|/]\s*IFC[A-Z0-9]+$/],
  // Kernel CSG failure reasons; emitted as a `{ reason, count }` array here.
  ['failuresByReason', /^[A-Za-z]+$/],
  ['ruleCounts', /^[a-z0-9-]+\/(?:error|warning|info)$/],
  // Closed vocabulary, shared with lib/model-id.mjs rather than restated. The
  // restated form here was `/^(?:Qto_[A-Za-z0-9]+|...)$/`, i.e. the same
  // overbroad prefix rule the emitting filter had, so the guard could not
  // catch what the filter let through: two lines of defence, one hole.
  ['qsetLabelCounts', new Set([...STANDARD_QSET_NAMES, '<non-standard>'])],
  ['quantityLabelCounts', /^(?:[A-Za-z]+|<non-standard>)$/],
  ['groups', /^[a-z]+$/],
  ['perGroup', /^[a-z]+$/],
  ['committedRows', /^[a-z][a-z-]*$/],
  // Synthetic-side only, keyed by the corpus's own defect-type names.
  ['oracleByType', /^[a-z][a-z-]*$/],
  ['heuristicByType', /^[a-z][a-z-]*$/],
  ['bySeverity', /^(?:critical|major|minor|info)$/],
  ['sampledPairSeverityHistogram', /^(?:critical|major|minor|info)$/],
  // `RepresentationIdentifier/RepresentationType`. Both are IFC enumerated
  // vocabulary; `(unset)` is this bet's own sentinel for an absent attribute
  // and is spelled out so a legitimate run does not trip the guard.
  ['representationIdentifierAndType', /^(?:[A-Za-z0-9]+|\(unset\))\/(?:[A-Za-z0-9]+|\(unset\))$/],
  ['unmeshedRepresentationIdentifierAndType', /^(?:[A-Za-z0-9]+|\(unset\))\/(?:[A-Za-z0-9]+|\(unset\))$/],
  ['representationItemTypes', /^(?:IFC[A-Z0-9]+|Ifc[A-Za-z0-9]+|Unknown)$/],
  ['unmeshedRepresentationItemTypes', /^(?:IFC[A-Z0-9]+|Ifc[A-Za-z0-9]+|Unknown)$/],
  // The mapped-representation target of an unmeshed column's IfcMappedItem.
  ['unmeshedMappedTargetIdentifierAndType', /^(?:[A-Za-z0-9]+|\(unset\))\/(?:[A-Za-z0-9]+|\(unset\))$/],
  ['mappedTargetIdentifierAndType', /^(?:[A-Za-z0-9]+|\(unset\))\/(?:[A-Za-z0-9]+|\(unset\))$/],
  ['unmeshedMappedTargetItemTypes', /^(?:IFC[A-Z0-9]+|Ifc[A-Za-z0-9]+|Unknown)$/],
  // Keyed by authored storey / element / project name. No safe vocabulary.
  ['byStorey', null],
  ['byElement', null],
  ['byName', null],
  ['byProject', null],
  ['byOrganization', null],
  ['byOrganisation', null],
]);

/**
 * A key name that reads as "a map keyed by data" and is absent from the table
 * above is a hole, not a pass: it means an upstream pass started emitting a
 * dynamic map that nobody vetted. Deliberately narrower than "ends in Counts",
 * which also matches fixed-shape records like `foreignVerdictCounts`.
 */
const LOOKS_LIKE_A_MAP = /^by[A-Z]|(?:Histogram|LabelCounts|NameCounts|TypeCounts|ByEntityType|ByReason|ByType)$/;

/** `{ rule, severity, count }` rows, as ifc-lite's own validate / clash emit them. */
const RULE_ID_RE = /^[a-z0-9-]+$/;
const SEVERITY_RE = /^(?:critical|major|minor|info|error|warning)$/;
const FAILURE_REASON_RE = /^[A-Za-z]+$/;

function collectForbidden() {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--forbid' && process.argv[i + 1]) out.push(process.argv[i + 1]);
    if (process.argv[i] === '--forbid-file' && process.argv[i + 1]) {
      for (const line of readFileSync(process.argv[i + 1], 'utf-8').split('\n')) {
        const s = line.trim();
        if (s !== '' && !s.startsWith('#')) out.push(s);
      }
    }
  }
  const lowered = out.map((s) => s.toLowerCase());
  // A one- or two-character entry cannot be substring-matched without hitting
  // ordinary vocabulary, so it used to be dropped here - silently, while the
  // success line at the bottom of this file counted only what survived. An
  // operator who typed a client's initials would read "denylist entries
  // applied" and have suppressed nothing. Refuse the run instead; the whole
  // point of this list is that the operator is trusting it.
  const tooShort = lowered.filter((s) => s.length < 3);
  if (tooShort.length > 0) {
    process.stderr.write(`refusing to run: ${tooShort.length} denylist entr${tooShort.length === 1 ? 'y is' : 'ies are'} `
      + 'shorter than 3 characters and cannot be matched safely. Remove them or spell the name out.\n');
    process.exit(2);
  }
  return lowered;
}

function assertNoIdentifiers(root, label, forbidden) {
  const violations = [];
  /**
   * NEVER print the offending value. This guard's whole job is to stop an
   * identifier reaching a public artifact, and its failure message goes
   * straight into a CI log on a PUBLIC repository -- echoing the name there
   * would leak exactly what the guard just caught, in a place that is harder
   * to redact than the artifact was. So a violation reports WHERE it is and
   * WHAT rule it broke, plus a shape sketch (length and character classes)
   * that is enough to find the value locally and not enough to reconstruct it.
   * Run the build yourself to see the value; the log will not hand it over.
   */
  const sketch = (sample) => {
    const s = String(sample);
    const classes = [
      /[A-Z]/.test(s) ? 'A' : '',
      /[a-z]/.test(s) ? 'a' : '',
      /[0-9]/.test(s) ? '9' : '',
      /[^A-Za-z0-9]/.test(s) ? '_' : '',
    ].join('');
    return `<${s.length} chars, [${classes}]>`;
  };
  const fail = (where, why, sample) => violations.push(`${label}${where}: ${why} -> ${sketch(sample)}`);

  const checkText = (text, where, kind) => {
    if (typeof text !== 'string' || text === '') return;
    const fileName = MODEL_FILE_RE.exec(text);
    if (fileName) fail(where, `${kind} carries a model/CAD file name`, fileName[0]);
    if (FS_PATH_RE.test(text)) fail(where, `${kind} carries a filesystem path`, text.slice(0, 120));
    const lower = text.toLowerCase();
    for (const f of forbidden) {
      if (lower.includes(f)) fail(where, `${kind} contains a denylisted name`, '<redacted denylist hit>');
    }
  };

  const walk = (node, where) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${where}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') {
      checkText(node, where, 'value');
      return;
    }
    // `{ rule, severity, count }` and `{ reason, count }` rows carry ifc-lite's
    // own vocabulary; anything else in those slots came from the file.
    if (typeof node.rule === 'string' && 'severity' in node && 'count' in node) {
      if (!RULE_ID_RE.test(node.rule)) fail(`${where}.rule`, 'not an ifc-lite rule id', node.rule);
      if (!SEVERITY_RE.test(String(node.severity))) fail(`${where}.severity`, 'not a severity', node.severity);
    }
    if (typeof node.reason === 'string' && 'count' in node && !FAILURE_REASON_RE.test(node.reason)) {
      fail(`${where}.reason`, 'not a kernel failure reason', node.reason);
    }
    for (const [k, v] of Object.entries(node)) {
      checkText(k, `${where}.${k}`, 'key');
      const known = KEYED_BY_AUTHORED_TEXT.has(k);
      if (known || LOOKS_LIKE_A_MAP.test(k)) {
        if (!known) {
          fail(`${where}.${k}`, 'map-shaped key this guard was never taught; add it to KEYED_BY_AUTHORED_TEXT', k);
        } else {
          const pattern = KEYED_BY_AUTHORED_TEXT.get(k);
          if (pattern === null) {
            fail(`${where}.${k}`, 'this map is keyed by authored text and must not be emitted', k);
          } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            const allows = pattern instanceof Set ? (mk) => pattern.has(mk) : (mk) => pattern.test(mk);
            const shown = pattern instanceof Set ? `a closed set of ${pattern.size} names` : String(pattern);
            for (const mk of Object.keys(v)) {
              if (!allows(mk)) fail(`${where}.${k}`, `key outside the allowed vocabulary ${shown}`, mk);
            }
          }
        }
      }
      walk(v, `${where}.${k}`);
    }
  };

  walk(root, '');
  if (violations.length > 0) {
    process.stderr.write(`identifier guard FAILED with ${violations.length} violation(s):\n`);
    for (const v of violations) process.stderr.write(`  ${v}\n`);
    process.stderr.write('nothing was written. Measurements are publishable; names are not.\n');
    process.exit(1);
  }
}

const FORBIDDEN = collectForbidden();
const copies = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
for (const f of copies) assertNoIdentifiers(readJson(join(runsDir, f)), `results/${f}`, FORBIDDEN);
assertNoIdentifiers(scorecard, 'scorecard.json', FORBIDDEN);

mkdirSync(join(outDir, 'results'), { recursive: true });
for (const f of copies) copyFileSync(join(runsDir, f), join(outDir, 'results', f));
writeFileSync(join(outDir, 'scorecard.json'), `${JSON.stringify(scorecard, null, 2)}\n`, 'utf-8');
process.stdout.write(`wrote ${join(outDir, 'scorecard.json')} (identifier guard passed over ${copies.length} pass artifacts + the scorecard`
  + `${FORBIDDEN.length > 0 ? `, with ${FORBIDDEN.length} operator-supplied denylist entries` : ', no operator denylist supplied'})\n`);
