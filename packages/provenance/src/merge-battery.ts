/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The M4 midterm property battery (Bet B2.1, docs/vision/
 * moonshots-execution-plan.md section 2 M4 exams: "soundness property test,
 * 1,000 randomized two-client op schedules, zero unsound auto-merges (an
 * auto-merge whose replay differs from sequential application), with
 * conflict rate reported").
 *
 * Every schedule: build a randomized base model (seeded PRNG -- mulberry32,
 * the same generator dag-engine.test.ts and g2-footprint-tightness.mjs use;
 * no Date.now / bare Math.random anywhere), have two simulated clients each
 * derive an op set against their own replica of the base, then:
 *
 * - run {@link createCommutationCertificate}. If it certifies, the schedule
 *   was AUTO-MERGED: the certificate's own internal check already replayed
 *   both orders and required byte-identical convergence, and this battery
 *   counts any `apply-failed` / `non-commutative` outcome (predicate said
 *   "safe", replay disagreed) as an UNSOUND AUTO-MERGE. The exam bar is
 *   exactly zero of those across all schedules.
 * - if it refuses with `conflict`, the schedule is FLAGGED. Ground truth is
 *   then computed where computable ({@link attemptBothOrders}): if both
 *   orders replay cleanly AND converge byte-identically, the ops actually
 *   commuted and the flag was a FALSE CONFLICT; if either order fails to
 *   apply or the orders diverge, the flag was a true conflict.
 *
 * Reported rates:
 * - `conflictRate`   = flaggedConflicts / schedules.
 * - `falseConflictRate` = falseConflicts / groundTruthConvergent, where
 *   groundTruthConvergent = autoMerged + falseConflicts (every schedule
 *   whose ground truth is "commutes"). This is the M4 kill-criterion
 *   quantity (plan section 5: below 20% or provable auto-merge is
 *   "technically true but practically annoying").
 *
 * A sample of issued certificates (every `verifyEvery`-th) is additionally
 * pushed through {@link verifyCommutationCertificate}; any failure is
 * reported (and fails the exam -- a certificate that does not verify is
 * worthless).
 */

import { DEFAULT_EPSILON_MM } from './footprint.js';
import type { GeometryMeshPayload, PropertySetPayload, PropertyValue } from './node-hash.js';
import type { EntityInit, EntityState, MergeOp, ModelState } from './merge-model.js';
import {
  attemptBothOrders,
  createCommutationCertificate,
  verifyCommutationCertificate,
} from './commutation.js';

/* ------------------------------------------------------------------ */
/* Seeded PRNG (mulberry32) -- same generator as dag-engine.test.ts      */
/* ------------------------------------------------------------------ */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/* ------------------------------------------------------------------ */
/* Base-model generator                                                  */
/* ------------------------------------------------------------------ */

const STOREY_IDS = ['S0', 'S1'] as const;
const ELEMENTS_PER_STOREY = 12;
const GRID_COLS = 4;
/** Metres between grid slots; unit-sized elements 3 m apart leave 2 m gaps,
 *  far beyond 2 * epsilon (0.1 m at the default 50 mm), so grid neighbours
 *  never spatially conflict unless an op actually relocates geometry. */
const GRID_SPACING = 3;
const STOREY_HEIGHT = 3;
const IFC_TYPES = ['IfcWall', 'IfcDoor', 'IfcColumn', 'IfcSlab', 'IfcBeam'] as const;
const FIRE_RATINGS = ['EI30', 'EI60', 'EI90'] as const;
const STATUS_VALUES = ['New', 'Existing', 'Demolish'] as const;
const ATTR_NAMES = ['IsExternal', 'FireRating', 'LoadBearing', 'NetVolume', 'Height', 'Status'] as const;

/** Unit right triangle in the XY plane, placed via origin -- AABB is
 *  origin + [0..1, 0..1, 0]. */
function triangleMesh(expressId: number, origin: readonly [number, number, number]): GeometryMeshPayload {
  return {
    expressId,
    geometryClass: 0,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    origin,
  };
}

function gridOrigin(storeyIndex: number, elementIndex: number): [number, number, number] {
  return [
    (elementIndex % GRID_COLS) * GRID_SPACING,
    Math.floor(elementIndex / GRID_COLS) * GRID_SPACING,
    storeyIndex * STOREY_HEIGHT,
  ];
}

/** Randomized but seeded base model: 2 storeys x 12 unit elements on a 3 m
 *  grid, each with one mesh leaf and two pset leaves. */
export function buildBaseModel(rng: Rng): ModelState {
  const entities = new Map<string, EntityState>();
  let expressId = 100;
  for (let s = 0; s < STOREY_IDS.length; s++) {
    for (let e = 0; e < ELEMENTS_PER_STOREY; e++) {
      const tag = `${s}-${e}`;
      const entityNodeId = `element:${tag}`;
      const psets = new Map<string, PropertySetPayload>([
        [
          `pset:${tag}:common`,
          {
            name: 'Pset_Common',
            properties: [
              { name: 'IsExternal', value: rng() < 0.5 },
              { name: 'FireRating', value: pick(rng, FIRE_RATINGS) },
              { name: 'LoadBearing', value: rng() < 0.5 },
            ],
          },
        ],
        [
          `pset:${tag}:quantities`,
          {
            name: 'Pset_Quantities',
            properties: [
              { name: 'NetVolume', value: Math.round(rng() * 1000) / 100 },
              { name: 'Height', value: Math.round(rng() * 400) / 100 },
            ],
          },
        ],
      ]);
      const meshes = new Map<string, GeometryMeshPayload>([
        [`mesh:${tag}:0`, triangleMesh(expressId++, gridOrigin(s, e))],
      ]);
      entities.set(entityNodeId, {
        key: `GUID-${tag}`,
        ifcType: pick(rng, IFC_TYPES),
        storeyId: STOREY_IDS[s],
        psets,
        meshes,
      });
    }
  }
  return { storeyIds: [...STOREY_IDS], entities };
}

/* ------------------------------------------------------------------ */
/* Client op-set generator                                               */
/* ------------------------------------------------------------------ */

function randomAttrValue(rng: Rng, property: string): PropertyValue {
  if (property === 'IsExternal' || property === 'LoadBearing') return rng() < 0.5;
  if (property === 'NetVolume' || property === 'Height') return Math.round(rng() * 1000) / 100;
  if (property === 'FireRating') return pick(rng, FIRE_RATINGS);
  return pick(rng, STATUS_VALUES);
}

/** Grid extents in metres, for relocation targets. */
const EXTENT_X = GRID_COLS * GRID_SPACING;
const EXTENT_Y = (ELEMENTS_PER_STOREY / GRID_COLS) * GRID_SPACING;

interface ClientContext {
  client: string;
  scheduleIndex: number;
  rng: Rng;
}

/**
 * Generate one client's op set (1..3 ops) against its own replica. Ops are
 * generated sequentially against the client's local state, so a client never
 * produces a self-invalid sequence (e.g. editing an entity it just removed).
 * Added entities are not targeted by the client's later ops (their node ids
 * are unknown to the base DAG the footprints are computed against).
 *
 * Op mix: attr-set 45%, geometry-replace 30%, entity-add 15%,
 * entity-remove 10%. `entity-add` ids are fresh per client/schedule 80% of
 * the time; 20% they come from a tiny shared pool so genuine add/add id
 * collisions occur across clients and exercise the structural predicate.
 */
export function generateClientOps(base: ModelState, ctx: ClientContext): MergeOp[] {
  const { rng, client, scheduleIndex } = ctx;
  const removed = new Set<string>();
  const addedTags = new Set<string>();
  const ops: MergeOp[] = [];
  const opCount = 1 + Math.floor(rng() * 3);
  let addCounter = 0;

  for (let i = 0; i < opCount; i++) {
    const available = [...base.entities.keys()].filter((id) => !removed.has(id));
    if (available.length === 0) break;
    const opId = `s${scheduleIndex}-${client}-${i}`;
    const roll = rng();

    if (roll < 0.45) {
      const entityId = pick(rng, available);
      const entity = base.entities.get(entityId);
      if (!entity) continue;
      const psetNodeId = pick(rng, [...entity.psets.keys()]);
      const property = pick(rng, ATTR_NAMES);
      ops.push({ opId, type: 'attr-set', psetNodeId, property, value: randomAttrValue(rng, property) });
    } else if (roll < 0.75) {
      const entityId = pick(rng, available);
      const entity = base.entities.get(entityId);
      if (!entity) continue;
      const meshNodeId = pick(rng, [...entity.meshes.keys()]);
      const old = entity.meshes.get(meshNodeId) as GeometryMeshPayload;
      const relocate = rng() < 0.15;
      const origin: [number, number, number] = relocate
        ? [rng() * EXTENT_X, rng() * EXTENT_Y, old.origin[2]]
        : [old.origin[0] + (rng() - 0.5) * 0.8, old.origin[1] + (rng() - 0.5) * 0.8, old.origin[2]];
      ops.push({ opId, type: 'geometry-replace', meshNodeId, payload: triangleMesh(old.expressId, origin) });
    } else if (roll < 0.9) {
      const shared = rng() < 0.2;
      let tag = shared
        ? `shared-add-${Math.floor(rng() * 2)}`
        : `add-${client}-${scheduleIndex}-${addCounter++}`;
      if (addedTags.has(tag)) {
        // A client never adds the same id twice (its own sequence would be
        // self-invalid); cross-CLIENT shared-tag collisions are the point.
        tag = `add-${client}-${scheduleIndex}-${addCounter++}`;
      }
      addedTags.add(tag);
      const storeyId = pick(rng, base.storeyIds);
      const entity: EntityInit = {
        entityNodeId: `element:${tag}`,
        key: `GUID-${tag}`,
        ifcType: pick(rng, IFC_TYPES),
        storeyId,
        psets: [
          {
            psetNodeId: `pset:${tag}:common`,
            payload: { name: 'Pset_Common', properties: [{ name: 'Status', value: pick(rng, STATUS_VALUES) }] },
          },
        ],
        meshes: [
          {
            meshNodeId: `mesh:${tag}:0`,
            payload: triangleMesh(
              9000 + scheduleIndex * 10 + addCounter,
              [rng() * EXTENT_X, rng() * EXTENT_Y, (storeyId === STOREY_IDS[0] ? 0 : 1) * STOREY_HEIGHT],
            ),
          },
        ],
      };
      ops.push({ opId, type: 'entity-add', entity });
    } else {
      const entityId = pick(rng, available);
      removed.add(entityId);
      ops.push({ opId, type: 'entity-remove', entityNodeId: entityId });
    }
  }
  return ops;
}

/* ------------------------------------------------------------------ */
/* The battery                                                           */
/* ------------------------------------------------------------------ */

export interface MergeBatteryOptions {
  /** Default 1000 (the M4 midterm count). */
  schedules?: number;
  /** Default 20260724 (same convention as g2-footprint-tightness.mjs). */
  seed?: number;
  /** Default {@link DEFAULT_EPSILON_MM}. */
  epsilonMm?: number;
  /** Verify every N-th issued certificate end to end (0 disables).
   *  Default 25. */
  verifyEvery?: number;
}

export interface MergeBatteryReport {
  schedules: number;
  seed: number;
  epsilonMm: number;
  /** Schedules the predicate cleared and the merge converged on. */
  autoMerged: number;
  /** Predicate said "no conflict" but replay failed or diverged. The exam
   *  bar is exactly zero. */
  unsoundAutoMerges: number;
  unsoundScheduleIndices: readonly number[];
  flaggedConflicts: number;
  /** Flagged, and ground truth confirms the orders genuinely do not commute
   *  (an order fails to apply, or the orders diverge). */
  trueConflicts: number;
  /** Flagged, but both orders replay cleanly and converge byte-identically:
   *  the ops commuted and the flag was over-approximation. */
  falseConflicts: number;
  /** autoMerged + falseConflicts: every schedule whose ground truth is
   *  "commutes". */
  groundTruthConvergent: number;
  conflictRate: number;
  /** falseConflicts / groundTruthConvergent (0 when the denominator is 0). */
  falseConflictRate: number;
  certificatesIssued: number;
  certificatesVerified: number;
  certificateFailures: number;
  /** Zero unsound auto-merges AND zero certificate verification failures. */
  examPass: boolean;
  /** falseConflictRate < 0.2 (plan section 5, M4). */
  killCriterionPass: boolean;
  elapsedMs: number;
}

export async function runMergeBattery(options: MergeBatteryOptions = {}): Promise<MergeBatteryReport> {
  const schedules = options.schedules ?? 1000;
  const seed = options.seed ?? 20260724;
  const epsilonMm = options.epsilonMm ?? DEFAULT_EPSILON_MM;
  const verifyEvery = options.verifyEvery ?? 25;

  const rng = mulberry32(seed);
  const start = performance.now();

  let autoMerged = 0;
  const unsoundScheduleIndices: number[] = [];
  let flaggedConflicts = 0;
  let trueConflicts = 0;
  let falseConflicts = 0;
  let certificatesIssued = 0;
  let certificatesVerified = 0;
  let certificateFailures = 0;

  for (let s = 0; s < schedules; s++) {
    const base = buildBaseModel(rng);
    const opsA = generateClientOps(base, { client: 'a', scheduleIndex: s, rng });
    const opsB = generateClientOps(base, { client: 'b', scheduleIndex: s, rng });

    const outcome = await createCommutationCertificate({
      base,
      opsA,
      opsB,
      epsilonMm,
      clientA: 'client-a',
      clientB: 'client-b',
    });

    if (outcome.ok) {
      autoMerged++;
      certificatesIssued++;
      if (verifyEvery > 0 && certificatesIssued % verifyEvery === 0) {
        const verification = await verifyCommutationCertificate(outcome.certificate, base, opsA, opsB);
        certificatesVerified++;
        if (!verification.ok) certificateFailures++;
      }
    } else if (outcome.reason === 'conflict') {
      flaggedConflicts++;
      const truth = attemptBothOrders(base, opsA, opsB);
      if (truth.status === 'converged') falseConflicts++;
      else trueConflicts++;
    } else {
      // apply-failed / non-commutative on a predicate-approved pair: the
      // definition of an unsound auto-merge.
      unsoundScheduleIndices.push(s);
    }
  }

  const elapsedMs = performance.now() - start;
  const groundTruthConvergent = autoMerged + falseConflicts;
  const conflictRate = schedules === 0 ? 0 : flaggedConflicts / schedules;
  const falseConflictRate = groundTruthConvergent === 0 ? 0 : falseConflicts / groundTruthConvergent;
  const unsoundAutoMerges = unsoundScheduleIndices.length;

  return {
    schedules,
    seed,
    epsilonMm,
    autoMerged,
    unsoundAutoMerges,
    unsoundScheduleIndices,
    flaggedConflicts,
    trueConflicts,
    falseConflicts,
    groundTruthConvergent,
    conflictRate,
    falseConflictRate,
    certificatesIssued,
    certificatesVerified,
    certificateFailures,
    examPass: unsoundAutoMerges === 0 && certificateFailures === 0,
    killCriterionPass: falseConflictRate < 0.2,
    elapsedMs,
  };
}
