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
 * Usage:
 *   node build-scorecard.mjs --runs <dir with the pass JSONs> [--out <dir>]
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIZE_BUCKET_MB, ENTITY_COUNT_BUCKET } from './lib/model-id.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const BENCH_RESULTS = join(REPO, 'tools/world-gym/benchmark/results');

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
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
    decidedBy: 'adjudication.globalIdScan.duplicateGroupsByEntityType is entirely IFCPROPERTYSINGLEVALUE, with kernelUniqueGlobalIdErrors = 0',
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
    decidedBy: 'adjudication.unmeshedColumns.unmeshedRepresentationIdentifierAndType',
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

// NOTE on the foreign rows: every scale figure below divides by a BUCKETED
// entity count and a BUCKETED byte size (lib/model-id.mjs), because the exact
// values are a re-identification vector on a delivered client file. The ratios
// are therefore accurate to the bucket, which is far finer than any claim the
// report makes from them.
const scaleRow = (a) => ({
  alias: a,
  approxEntityCount: foreign[a].text.approxEntityCount,
  entityCountVsSyntheticMedian: round(foreign[a].text.approxEntityCount / medianEntityCount, 1),
  approxMegabytes: foreign[a].text.approxMegabytes,
  bytesVsSyntheticMedian: round((foreign[a].text.approxMegabytes * 1e6) / medianBytes, 1),
  oracleMs: foreign[a].oracle.oracleMs,
  oracleMsVsSyntheticMedian: round(foreign[a].oracle.oracleMs / medianOracleMs, 1),
  heuristicMs: foreign[a].text.heuristicMs,
  heuristicMsVsSyntheticMedian: round(foreign[a].text.heuristicMs / medianHeuristicMs, 1),
  // Sampled at pass exit, not a high-water mark - see run-oracle-pass.mjs.
  oracleRssAtExitMb: foreign[a].oracle.rssAtExitMb,
  // Cost per entity is the scale-normalised comparison: it says whether the
  // instrument merely met a bigger file or got worse per unit of work.
  oracleUsPerEntity: round((foreign[a].oracle.oracleMs * 1000) / foreign[a].text.approxEntityCount, 3),
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
    foreignDeidentification: {
      note: 'both foreign models are real delivered client work. Descriptors that would let a reader holding a candidate file CONFIRM a match - a sha256 prefix, an exact byte length, an exact entity count, a counted element histogram - are not emitted here or in results/*.json; what remains is bucketed or ordinal. See lib/model-id.mjs.',
      sizeBucketMegabytes: SIZE_BUCKET_MB,
      entityCountBucket: ENTITY_COUNT_BUCKET,
      dominantElementTypesEmitted: foreign['model-a'].text.dominantElementTypes.length,
    },
    foreign: ALIASES.map((a) => ({
      alias: a,
      authoringToolFamily: foreign[a].text.authoringToolFamily,
      schema: foreign[a].text.schema,
      approxMegabytes: foreign[a].text.approxMegabytes,
      approxEntityCount: foreign[a].text.approxEntityCount,
      distinctEntityTypes: foreign[a].text.distinctEntityTypes,
      dominantElementTypes: foreign[a].text.dominantElementTypes,
      meshedElementCount: foreign[a].kernel.clash.meshedElementCount,
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
// "Every unmeshed column declares a Representation, and none of them is a
// Body" is two claims. The second is repKeys; the FIRST is only true when no
// unmeshed column declared nothing at all, so it is asserted rather than
// assumed - otherwise the sentence overstates the artifact.
const bodyless = repKeys.length > 0
  && degenA.unmeshedDeclaringNoRepresentation === 0
  && !repKeys.some((k) => k.startsWith('Body/'));
degRow.reading = bodyless
  ? `every one of the ${degenA.unmeshedColumns} unmeshed columns declares a Representation, but none of those representations is a Body: the whole set is ${repKeys.join(', ')}. So the kernel is right to produce no mesh, the file really does ship columns with no solid geometry, and the verdict points at something real - but the defect type it names ("degenerate-geometry", planted in the corpus as a zero-depth extrusion) is not what is there. Classed true-signal-wrong-label.`
  : `${degenA.unmeshedDeclaringNoRepresentation} of the ${degenA.unmeshedColumns} unmeshed columns declare no Representation at all; the remaining ${degenA.unmeshedDeclaringRepresentation} declare ${repKeys.length > 0 ? repKeys.join(', ') : 'no shape representation this probe could read'}.`;

mkdirSync(join(outDir, 'results'), { recursive: true });
for (const f of readdirSync(runsDir)) {
  if (f.endsWith('.json')) copyFileSync(join(runsDir, f), join(outDir, 'results', f));
}
writeFileSync(join(outDir, 'scorecard.json'), `${JSON.stringify(scorecard, null, 2)}\n`, 'utf-8');
process.stdout.write(`wrote ${join(outDir, 'scorecard.json')}\n`);
