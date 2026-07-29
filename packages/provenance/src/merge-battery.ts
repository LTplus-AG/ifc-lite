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
 *
 * ## Spatial decomposition (Bet B4.2)
 *
 * The G2 red-team review (docs/vision/reviews/g2-red-team-2026-07-24.md §4)
 * showed that under the v0 op model the SPATIAL half of the conflict
 * predicate could not produce a true conflict at all: application was purely
 * per-node, so node-disjoint ops always commuted byte-identically, and every
 * spatial-only flag was false by construction. merge-model.ts now carries
 * host/opening coupling (containment rejection + lazy void re-cut), so the
 * base model here plants real hosts with real openings and the client
 * generator edits both sides of that relationship.
 *
 * To make the finding falsifiable rather than merely re-run, every flagged
 * schedule is classified by WHICH rule fired -- structural-only, spatial-only
 * or both -- and ground truth is tallied per class. The two numbers the B4.2
 * exam turns on are {@link MergeBatteryReport.spatialFiredFalseConflictRate}
 * (over-approximation restricted to schedules where the spatial rule fired)
 * and {@link MergeBatteryReport.spatialOnlyTrueConflicts} (conflicts that
 * ONLY the spatial rule caught -- if that is zero, the rule earns nothing and
 * the pre-committed consequence is to delete it).
 *
 * ## The ablation (G4 review item 6)
 *
 * The G4 red-team review (docs/vision/reviews/g4-red-team-2026-07-29.md §2,
 * §7 item 6) pointed out that the whole soundness argument for the coupled
 * semantics *depends* on the spatial rule, and that an argument of that shape
 * should be tested by removing the rule rather than by counting what it
 * caught. {@link runSpatialAblation} does exactly that: the SAME 1,000
 * schedules (same seed, same generator, same op model), the predicate reduced
 * to structural overlap only, counting the cross pairs the reduced predicate
 * CLEARS that do not actually commute --
 * {@link SpatialAblationReport.unsoundAutoMerges}.
 *
 * Precisely what that count is, since the distinction matters and is easy to
 * overstate: no unsound certificate is ever emitted, in either mode.
 * `createCommutationCertificate` replays both orders itself and refuses on
 * `apply-failed` / `non-commutative` regardless of what the predicate said.
 * The count is the number of times the PREDICATE -- the part of the scheme
 * that decides, and the part this bet is about -- was wrong in the unsafe
 * direction, which is exactly the quantity the M4 exam's "zero unsound
 * auto-merges" bar is stated over (see the head of this docstring). The
 * ablation is measured in the same units as the exam so the two are
 * comparable: 0 with the rule, N without it.
 *
 * Read the result honestly, in either direction:
 *
 * - **non-zero** -- the rule is load-bearing for the PREDICATE, not merely a
 *   conflict counter: every spatial-only true conflict is a pair the reduced
 *   predicate would have waved through. It is NOT load-bearing for the
 *   certificate, which the replay backstop protects either way -- see "What
 *   the spatial rule actually buys" below, which is the statement that should
 *   be quoted.
 * - **zero** -- the predicate needs no spatial half under this op model, and
 *   the rule buys nothing but replay-cost avoidance on schedules that all
 *   commute. That is a real negative result and must be reported as one.
 *
 * The identity `unsoundAutoMerges(ablated) == spatialOnlyTrueConflicts` holds
 * BY CONSTRUCTION and is asserted, not hoped for: a schedule classified
 * `spatialOnly` has no structurally-conflicting cross pair at all (a
 * structural conflict would have been flagged), so the ablated predicate
 * certifies it, and if its ground truth is "does not commute" the certificate
 * is unsound. The ablation is therefore a RE-DERIVATION of that count through
 * the certificate-issuing path, not independent evidence -- which is the point
 * (it is the same fact stated in the units that matter), and it is stated that
 * way rather than presented as a second, corroborating measurement.
 *
 * ## What the spatial rule actually buys (G4 item 7)
 *
 * The sentence above -- "without the rule the predicate clears 9 pairs that do
 * not commute" -- overclaims, and the adversarial re-review of G4 was right to
 * say so. Two corrections, both measured here rather than argued.
 *
 * **1. The rule does not buy soundness of the certificate.** "Zero unsound
 * auto-merges" is guaranteed by {@link createCommutationCertificate}, which
 * replays BOTH orders and refuses on `apply-failed` / `non-commutative`
 * whatever the predicate said. Delete the spatial rule entirely and no unsound
 * certificate is emitted; the ablation's own `certificateFailures: 0` says so.
 * What the rule buys is that the predicate refuses those schedules BEFORE the
 * replay, so the replay backstop never has to run on them:
 * **replay-cost avoidance on 28 schedules, at the price of 19 false
 * refusals** (seed 20260724, 1,000 schedules; `byRule.spatialOnly.flagged` and
 * `byRule.spatialOnly.falseConflicts`). Of the 28, 9 are pairs the replay
 * would have had to catch and 19 are pairs the replay would have certified.
 * That is the honest statement of the trade: a cheap conservative filter in
 * front of an expensive exact check, priced at a 19-in-28 false-refusal rate.
 *
 * **2. The 9 is a property of two modelling choices, and its sensitivity is
 * published with it.** {@link runDerivedCutSensitivity} re-scores the same
 * 1,000 schedules under the 2x2 of {@link MergeSemantics}. Measured, seed
 * 20260724:
 *
 * | cuts / containment | enforced | off |
 * |---|---|---|
 * | lazy (B4.2 default) | **9** (3 apply-failed, 6 diverged) | 9 (0, 9) |
 * | derived (IFC + this repo) | **3** (3, 0) | **0** |
 *
 * (schedule stream pinned to the baseline, so each cell is an attribution of
 * the SAME 9 events. Regenerating the stream under each variant's own
 * semantics gives 3 / 13 / **1**.)
 *
 * So: the G4 reviewers' 9 -> 3 REPRODUCES exactly, by both methods, and their
 * final 1 reproduces under the regenerating method (0 under the
 * schedule-matched one). But their *decomposition* -- "3 from containment, 6
 * from the lazy cut" -- does not hold as a partition. Turning containment off
 * ALONE leaves the count at 9: the three containment rejections become three
 * divergences of the stale cut instead. The stored lazy cut is the dominant
 * mechanism and sustains all 9 on its own; containment is load-bearing only
 * once the cut is derived. Neither number may be quoted without the other.
 *
 * The residual 1 in the regenerated derived/off cell is worth naming because
 * it is the only one of the 9 that survives every correction: client A adds an
 * opening hosted in `element:1-8` while client B removes `element:1-8`, so one
 * order applies and the other cannot. That is `IfcRelVoidsElement` referential
 * integrity, which IFC really does impose, and the spatial rule is the only
 * half of the predicate that catches it (the add's `writtenNodes` are fresh
 * ids, structurally disjoint from the remove; only the host-region union in
 * `computeMergeOpFootprint` intersects it).
 */

import { aabbFromMesh, unionAabb, DEFAULT_EPSILON_MM, type Aabb } from './footprint.js';
import type { GeometryMeshPayload, PropertySetPayload, PropertyValue } from './node-hash.js';
import {
  applyOp,
  DEFAULT_MERGE_SEMANTICS,
  OpApplicationError,
  stripVoidMarkers,
  type EntityInit,
  type EntityState,
  type MergeOp,
  type MergeSemantics,
  type ModelState,
} from './merge-model.js';
import {
  attemptBothOrders,
  createCommutationCertificate,
  findCrossConflicts,
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
const OPENING_TYPE = 'IfcOpeningElement';
const FIRE_RATINGS = ['EI30', 'EI60', 'EI90'] as const;
const STATUS_VALUES = ['New', 'Existing', 'Demolish'] as const;
const ATTR_NAMES = ['IsExternal', 'FireRating', 'LoadBearing', 'NetVolume', 'Height', 'Status'] as const;
/** Every other grid element hosts one opening (B4.2): enough coupling for the
 *  spatial rule to have something true to say, few enough that most of the
 *  model is still plain node-disjoint editing. */
const HOST_EVERY = 2;
/** Edge length of a hosted opening, metres. Small enough to leave real slack
 *  inside a unit host, so an opening can be moved both legally and illegally. */
const OPENING_SIZE = 0.2;

/** Right triangle in the XY plane with legs `size`, placed via origin -- AABB
 *  is origin + [0..size, 0..size, 0]. */
function triangleMesh(
  expressId: number,
  origin: readonly [number, number, number],
  size = 1,
): GeometryMeshPayload {
  return {
    expressId,
    geometryClass: 0,
    positions: [0, 0, 0, size, 0, 0, 0, size, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    origin,
  };
}

/** Same geometry, new placement -- what a client proposes when it moves an
 *  element. Any void markers a previous re-cut appended are stripped by the
 *  caller, so a client always proposes UNCUT geometry. */
function movedMesh(mesh: GeometryMeshPayload, origin: readonly [number, number, number]): GeometryMeshPayload {
  return {
    expressId: mesh.expressId,
    geometryClass: mesh.geometryClass,
    positions: Array.from(mesh.positions),
    normals: Array.from(mesh.normals),
    indices: Array.from(mesh.indices),
    origin: [origin[0], origin[1], origin[2]],
  };
}

/** World-space bounds of an entity's UNCUT geometry. */
function entityBaseAabb(entity: EntityState): Aabb | undefined {
  const boxes: Aabb[] = [];
  for (const mesh of entity.meshes.values()) boxes.push(aabbFromMesh(stripVoidMarkers(mesh)));
  return boxes.length > 0 ? unionAabb(boxes) : undefined;
}

function gridOrigin(storeyIndex: number, elementIndex: number): [number, number, number] {
  return [
    (elementIndex % GRID_COLS) * GRID_SPACING,
    Math.floor(elementIndex / GRID_COLS) * GRID_SPACING,
    storeyIndex * STOREY_HEIGHT,
  ];
}

function commonPsets(rng: Rng, tag: string): Map<string, PropertySetPayload> {
  return new Map<string, PropertySetPayload>([
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
}

/**
 * Randomized but seeded base model: 2 storeys x 12 unit elements on a 3 m
 * grid, each with one mesh leaf and two pset leaves -- and, on every
 * {@link HOST_EVERY}-th element, one hosted `IfcOpeningElement` placed
 * strictly inside it (B4.2). The opening is an ordinary entity in the same
 * storey with its own leaves; what makes it special is `hostId`, which the op
 * model reads to enforce containment and to re-cut the host.
 */
export function buildBaseModel(rng: Rng): ModelState {
  const entities = new Map<string, EntityState>();
  let expressId = 100;
  for (let s = 0; s < STOREY_IDS.length; s++) {
    for (let e = 0; e < ELEMENTS_PER_STOREY; e++) {
      const tag = `${s}-${e}`;
      const entityNodeId = `element:${tag}`;
      const origin = gridOrigin(s, e);
      entities.set(entityNodeId, {
        key: `GUID-${tag}`,
        ifcType: pick(rng, IFC_TYPES),
        storeyId: STOREY_IDS[s],
        psets: commonPsets(rng, tag),
        meshes: new Map<string, GeometryMeshPayload>([[`mesh:${tag}:0`, triangleMesh(expressId++, origin)]]),
      });

      if (e % HOST_EVERY !== 0) continue;
      // One opening, inset far enough from both host faces that it can be
      // moved legally in either direction -- and illegally if pushed hard.
      const voidTag = `${tag}-void`;
      const inset = 0.1 + rng() * (1 - OPENING_SIZE - 0.2);
      const insetY = 0.1 + rng() * (1 - OPENING_SIZE - 0.2);
      entities.set(`element:${voidTag}`, {
        key: `GUID-${voidTag}`,
        ifcType: OPENING_TYPE,
        storeyId: STOREY_IDS[s],
        hostId: entityNodeId,
        psets: new Map<string, PropertySetPayload>([
          [
            `pset:${voidTag}:common`,
            { name: 'Pset_Common', properties: [{ name: 'Status', value: pick(rng, STATUS_VALUES) }] },
          ],
        ]),
        meshes: new Map<string, GeometryMeshPayload>([
          [
            `mesh:${voidTag}:0`,
            triangleMesh(expressId++, [origin[0] + inset, origin[1] + insetY, origin[2]], OPENING_SIZE),
          ],
        ]),
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

interface CandidateContext extends ClientContext {
  opId: string;
  addedTags: Set<string>;
  nextAddCounter: () => number;
}

/**
 * One candidate op against the client's CURRENT local state. Targets are
 * always drawn from ids that exist in the BASE state (footprints are computed
 * against the base DAG, so an op naming a node only the client knows about
 * could not be footprinted) and that are still live locally.
 *
 * Op mix: attr-set 40%, geometry-replace 40% (target drawn uniformly over
 * live meshes, so roughly a third land on hosts and a third on hosted
 * openings), entity-add 12%, entity-remove 8%.
 */
function buildCandidateOp(base: ModelState, local: ModelState, ctx: CandidateContext): MergeOp | null {
  const { rng, client, scheduleIndex, opId, addedTags } = ctx;
  const live = [...base.entities.keys()].filter((id) => local.entities.has(id));
  if (live.length === 0) return null;
  const roll = rng();

  if (roll < 0.4) {
    const entityId = pick(rng, live);
    const entity = local.entities.get(entityId) as EntityState;
    const psetIds = [...(base.entities.get(entityId) as EntityState).psets.keys()].filter((id) => entity.psets.has(id));
    if (psetIds.length === 0) return null;
    const psetNodeId = pick(rng, psetIds);
    const property = pick(rng, ATTR_NAMES);
    return { opId, type: 'attr-set', psetNodeId, property, value: randomAttrValue(rng, property) };
  }

  if (roll < 0.8) {
    const entityId = pick(rng, live);
    const entity = local.entities.get(entityId) as EntityState;
    const meshIds = [...(base.entities.get(entityId) as EntityState).meshes.keys()].filter((id) => entity.meshes.has(id));
    if (meshIds.length === 0) return null;
    const meshNodeId = pick(rng, meshIds);
    // Clients propose UNCUT geometry: whatever void record the kernel
    // appended on the last re-cut is not the client's to author.
    const old = stripVoidMarkers(entity.meshes.get(meshNodeId) as GeometryMeshPayload);
    // A hosted opening is never teleported across the model -- a client that
    // wanted that would be deleting and re-adding it.
    const relocate = entity.hostId === undefined && rng() < 0.15;
    const origin: [number, number, number] = relocate
      ? [rng() * EXTENT_X, rng() * EXTENT_Y, old.origin[2]]
      : [old.origin[0] + (rng() - 0.5) * 0.8, old.origin[1] + (rng() - 0.5) * 0.8, old.origin[2]];
    return { opId, type: 'geometry-replace', meshNodeId, payload: movedMesh(old, origin) };
  }

  if (roll < 0.92) {
    const shared = rng() < 0.2;
    const counter = ctx.nextAddCounter;
    let tag = shared ? `shared-add-${Math.floor(rng() * 2)}` : `add-${client}-${scheduleIndex}-${counter()}`;
    if (addedTags.has(tag)) {
      // A client never adds the same id twice (its own sequence would be
      // self-invalid); cross-CLIENT shared-tag collisions are the point.
      tag = `add-${client}-${scheduleIndex}-${counter()}`;
    }
    addedTags.add(tag);

    // 35% of adds cut a NEW opening into an existing host -- the add side of
    // the host coupling.
    const hostCandidates = live.filter((id) => {
      const entity = local.entities.get(id) as EntityState;
      return entity.hostId === undefined && entity.meshes.size > 0;
    });
    const asOpening = hostCandidates.length > 0 && rng() < 0.35;
    if (asOpening) {
      const hostId = pick(rng, hostCandidates);
      const host = local.entities.get(hostId) as EntityState;
      const hostBox = entityBaseAabb(host);
      if (!hostBox) return null;
      const slackX = Math.max(0, hostBox.max[0] - hostBox.min[0] - OPENING_SIZE);
      const slackY = Math.max(0, hostBox.max[1] - hostBox.min[1] - OPENING_SIZE);
      const entity: EntityInit = {
        entityNodeId: `element:${tag}`,
        key: `GUID-${tag}`,
        ifcType: OPENING_TYPE,
        storeyId: host.storeyId,
        hostId,
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
              9000 + scheduleIndex * 10 + counter(),
              [hostBox.min[0] + rng() * slackX, hostBox.min[1] + rng() * slackY, hostBox.min[2]],
              OPENING_SIZE,
            ),
          },
        ],
      };
      return { opId, type: 'entity-add', entity };
    }

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
            9000 + scheduleIndex * 10 + counter(),
            [rng() * EXTENT_X, rng() * EXTENT_Y, (storeyId === STOREY_IDS[0] ? 0 : 1) * STOREY_HEIGHT],
          ),
        },
      ],
    };
    return { opId, type: 'entity-add', entity };
  }

  return { opId, type: 'entity-remove', entityNodeId: pick(rng, live) };
}

/**
 * Generate one client's op set (up to 3 ops) against its own replica. Ops are
 * generated AND APPLIED sequentially against the client's local state, so a
 * client never produces a self-invalid sequence -- including under the B4.2
 * coupled semantics, where an op can be rejected on spatial grounds (a host
 * move that would evict its own opening, an opening move that would leave its
 * host). A candidate the client's own replica rejects is dropped, so every
 * apply-failure the battery later sees in a MERGED order is caused by the
 * other client's edits, never by a self-invalid schedule.
 *
 * Added entities are not targeted by the client's later ops (their node ids
 * are unknown to the base DAG the footprints are computed against).
 * `entity-add` ids are fresh per client/schedule 80% of the time; 20% they
 * come from a tiny shared pool so genuine add/add id collisions occur across
 * clients and exercise the structural predicate.
 */
export function generateClientOps(
  base: ModelState,
  ctx: ClientContext,
  semantics: MergeSemantics = DEFAULT_MERGE_SEMANTICS,
): MergeOp[] {
  const { rng, client, scheduleIndex } = ctx;
  const ops: MergeOp[] = [];
  const addedTags = new Set<string>();
  const opCount = 1 + Math.floor(rng() * 3);
  let addCounter = 0;
  let local = base;

  // A few spare attempts so a client that draws a rejected candidate still
  // ends up with an op set (the battery needs both clients to actually edit).
  const maxAttempts = opCount + 6;
  for (let attempt = 0; attempt < maxAttempts && ops.length < opCount; attempt++) {
    const candidate = buildCandidateOp(base, local, {
      rng,
      client,
      scheduleIndex,
      opId: `s${scheduleIndex}-${client}-${ops.length}`,
      addedTags,
      nextAddCounter: () => addCounter++,
    });
    if (!candidate) continue;
    try {
      local = applyOp(local, candidate, semantics);
    } catch (err) {
      // Rejected against the client's own replica (spatial or structural):
      // a real client would never have sent it.
      if (err instanceof OpApplicationError) continue;
      throw err;
    }
    ops.push(candidate);
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
  /**
   * Op-model semantics the schedules are SCORED under -- applied, replayed,
   * certified. Default {@link DEFAULT_MERGE_SEMANTICS} (the B4.2 semantics
   * every published number was measured under). The G4 item 7 sensitivity
   * variants pass `{ cuts: 'derived' }` and/or `{ containment: 'off' }` here.
   */
  semantics?: MergeSemantics;
  /**
   * Op-model semantics the SCHEDULE STREAM is generated under. Deliberately
   * separate from {@link MergeBatteryOptions.semantics} and defaulting to
   * {@link DEFAULT_MERGE_SEMANTICS} in both cases, because a sensitivity
   * variant that changes generation AND scoring changes two variables: the
   * generator drops candidates its own replica rejects, so containment-off
   * generation yields different op sets and the resulting count could not be
   * attributed to the schedules the headline was measured on. Set it equal to
   * `semantics` to ask the other question (what the world looks like if the
   * model had always worked that way); `runDerivedCutSensitivity` reports
   * both.
   */
  generatorSemantics?: MergeSemantics;
}

/** Ground-truth tally for one class of flagged schedule (B4.2). */
export interface ConflictClassTally {
  flagged: number;
  /** Ground truth says the orders genuinely do not commute. */
  trueConflicts: number;
  /** Ground truth says they commuted: the flag was over-approximation. */
  falseConflicts: number;
  /** Of `trueConflicts`: an order failed to apply (a spatial rejection, or a
   *  target the other client removed). */
  trueApplyFailed: number;
  /** Of `trueConflicts`: both orders applied but produced different bytes
   *  (in this model: a stale void cut). */
  trueDiverged: number;
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
  /**
   * Flagged schedules split by WHICH half of the predicate fired, with ground
   * truth per class (B4.2; the decomposition the G2 red-team review computed
   * by hand). Classification is at schedule level: a schedule is
   * `structuralOnly` if no flagged cross pair was spatial, `spatialOnly` if
   * none was structural, `both` otherwise. The three `flagged` counts sum to
   * {@link MergeBatteryReport.flaggedConflicts}.
   */
  byRule: {
    structuralOnly: ConflictClassTally;
    spatialOnly: ConflictClassTally;
    both: ConflictClassTally;
  };
  /** Schedules where the spatial rule fired at all (spatialOnly + both). */
  spatialFiredFlagged: number;
  spatialFiredTrueConflicts: number;
  spatialFiredFalseConflicts: number;
  /**
   * THE B4.2 exam number: false-conflict rate RESTRICTED to schedules where
   * the spatial rule fired -- `spatialFiredFalseConflicts /
   * spatialFiredFlagged`. Measured against the plan's < 20% bar.
   */
  spatialFiredFalseConflictRate: number;
  /**
   * THE B4.2 kill number: conflicts that ONLY the spatial rule caught. Under
   * the v0 (purely per-node) op model this was provably 0, which is what made
   * the spatial half of the predicate unfalsifiable. If it is still 0 under
   * the coupled semantics, the pre-committed consequence is to delete the
   * spatial rule.
   */
  spatialOnlyTrueConflicts: number;
  /** spatialFiredFalseConflictRate < 0.2 (the plan's bar, restricted). */
  spatialKillCriterionPass: boolean;
  /** spatialOnlyTrueConflicts > 0: the spatial rule earns its place. */
  spatialRuleContributes: boolean;
  certificatesIssued: number;
  certificatesVerified: number;
  certificateFailures: number;
  /** Zero unsound auto-merges AND zero certificate verification failures. */
  examPass: boolean;
  /** falseConflictRate < 0.2 (plan section 5, M4). */
  killCriterionPass: boolean;
  elapsedMs: number;
}

/** One generated schedule: a base model and both clients' op sets. */
interface Schedule {
  index: number;
  base: ModelState;
  opsA: MergeOp[];
  opsB: MergeOp[];
}

/**
 * The schedule stream, shared by {@link runMergeBattery} and
 * {@link runSpatialAblation}. Generation reads ONLY the seeded PRNG and the op
 * model -- never the conflict predicate -- so the same seed yields
 * byte-identical schedules in both modes. That is what makes the ablation an
 * ablation (one variable changed) rather than a second experiment; a test
 * pins it.
 */
function* enumerateSchedules(
  schedules: number,
  seed: number,
  semantics: MergeSemantics = DEFAULT_MERGE_SEMANTICS,
): Generator<Schedule> {
  const rng = mulberry32(seed);
  for (let index = 0; index < schedules; index++) {
    const base = buildBaseModel(rng);
    const opsA = generateClientOps(base, { client: 'a', scheduleIndex: index, rng }, semantics);
    const opsB = generateClientOps(base, { client: 'b', scheduleIndex: index, rng }, semantics);
    yield { index, base, opsA, opsB };
  }
}

export async function runMergeBattery(options: MergeBatteryOptions = {}): Promise<MergeBatteryReport> {
  const schedules = options.schedules ?? 1000;
  const seed = options.seed ?? 20260724;
  const epsilonMm = options.epsilonMm ?? DEFAULT_EPSILON_MM;
  const verifyEvery = options.verifyEvery ?? 25;
  const semantics = options.semantics ?? DEFAULT_MERGE_SEMANTICS;
  const generatorSemantics = options.generatorSemantics ?? DEFAULT_MERGE_SEMANTICS;

  const start = performance.now();

  let autoMerged = 0;
  const unsoundScheduleIndices: number[] = [];
  let flaggedConflicts = 0;
  let trueConflicts = 0;
  let falseConflicts = 0;
  let certificatesIssued = 0;
  let certificatesVerified = 0;
  let certificateFailures = 0;

  const emptyTally = (): ConflictClassTally => ({
    flagged: 0,
    trueConflicts: 0,
    falseConflicts: 0,
    trueApplyFailed: 0,
    trueDiverged: 0,
  });
  const byRule = { structuralOnly: emptyTally(), spatialOnly: emptyTally(), both: emptyTally() };

  for (const { index: s, base, opsA, opsB } of enumerateSchedules(schedules, seed, generatorSemantics)) {
    const outcome = await createCommutationCertificate({
      base,
      opsA,
      opsB,
      epsilonMm,
      clientA: 'client-a',
      clientB: 'client-b',
      semantics,
    });

    if (outcome.ok) {
      autoMerged++;
      certificatesIssued++;
      if (verifyEvery > 0 && certificatesIssued % verifyEvery === 0) {
        const verification = await verifyCommutationCertificate(outcome.certificate, base, opsA, opsB, { semantics });
        certificatesVerified++;
        if (!verification.ok) certificateFailures++;
      }
    } else if (outcome.reason === 'conflict') {
      flaggedConflicts++;
      const anyStructural = outcome.conflicts.some((c) => c.result.structural);
      const anySpatial = outcome.conflicts.some((c) => c.result.spatial);
      const tally = anyStructural && anySpatial ? byRule.both : anySpatial ? byRule.spatialOnly : byRule.structuralOnly;
      tally.flagged++;
      const truth = attemptBothOrders(base, opsA, opsB, semantics);
      if (truth.status === 'converged') {
        falseConflicts++;
        tally.falseConflicts++;
      } else {
        trueConflicts++;
        tally.trueConflicts++;
        if (truth.status === 'apply-failed') tally.trueApplyFailed++;
        else tally.trueDiverged++;
      }
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

  const spatialFiredFlagged = byRule.spatialOnly.flagged + byRule.both.flagged;
  const spatialFiredTrueConflicts = byRule.spatialOnly.trueConflicts + byRule.both.trueConflicts;
  const spatialFiredFalseConflicts = byRule.spatialOnly.falseConflicts + byRule.both.falseConflicts;
  const spatialFiredFalseConflictRate =
    spatialFiredFlagged === 0 ? 0 : spatialFiredFalseConflicts / spatialFiredFlagged;

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
    byRule,
    spatialFiredFlagged,
    spatialFiredTrueConflicts,
    spatialFiredFalseConflicts,
    spatialFiredFalseConflictRate,
    spatialOnlyTrueConflicts: byRule.spatialOnly.trueConflicts,
    spatialKillCriterionPass: spatialFiredFalseConflictRate < 0.2,
    spatialRuleContributes: byRule.spatialOnly.trueConflicts > 0,
    certificatesIssued,
    certificatesVerified,
    certificateFailures,
    examPass: unsoundAutoMerges === 0 && certificateFailures === 0,
    killCriterionPass: falseConflictRate < 0.2,
    elapsedMs,
  };
}

/* ------------------------------------------------------------------ */
/* The ablation: the same battery with the spatial rule switched off     */
/* ------------------------------------------------------------------ */

/**
 * Result of {@link runSpatialAblation}. Deliberately NOT a
 * {@link MergeBatteryReport}: an ablated run is not an exam, and a report that
 * carried `examPass: false` for a run that is SUPPOSED to produce unsound
 * merges would be read as a failure of the system rather than a measurement of
 * it. Nothing here gates anything.
 */
export interface SpatialAblationReport {
  schedules: number;
  seed: number;
  epsilonMm: number;
  /** Always `'disabled'` -- present so a stray JSON blob is self-describing
   *  and can never be mistaken for a real battery report. */
  spatialRule: 'disabled';
  /** Op-model semantics the schedules were SCORED under. Anything other than
   *  {@link DEFAULT_MERGE_SEMANTICS} is a G4 item 7 sensitivity variant, not
   *  the B4.2 headline. */
  semantics: MergeSemantics;
  /** Op-model semantics the schedule STREAM was generated under. Equal to
   *  {@link DEFAULT_MERGE_SEMANTICS} for the primary (schedule-matched)
   *  sensitivity variants. */
  generatorSemantics: MergeSemantics;
  /** Schedules the structural-only predicate cleared AND whose replay then
   *  converged: sound auto-merges that never needed the spatial rule. */
  autoMerged: number;
  /** Schedules the structural-only predicate still refused (structural
   *  overlap alone was enough). */
  flaggedConflicts: number;
  /**
   * THE ablation number, in the same units as the M4 exam's "zero unsound
   * auto-merges" bar: schedules where the structural-only predicate said
   * "safe" and the replay then FAILED or DIVERGED. No certificate is emitted
   * for these -- `createCommutationCertificate` replays both orders itself and
   * refuses -- so this counts the PREDICATE being wrong in the unsafe
   * direction, not certificates that shipped. See the module docstring's
   * ablation section.
   */
  unsoundAutoMerges: number;
  /** Of {@link unsoundAutoMerges}: an order threw (a containment rejection
   *  reading state the op does not write). */
  unsoundApplyFailed: number;
  /** Of {@link unsoundAutoMerges}: both orders applied and produced different
   *  canonical bytes (a stale lazy void cut). */
  unsoundDiverged: number;
  unsoundScheduleIndices: readonly number[];
  /**
   * Of `unsoundAutoMerges`, how many the FULL predicate refuses. Since the
   * ablated predicate cleared them, they have no structural conflict at all,
   * so any refusal by the full predicate is the spatial rule and nothing
   * else. Anything less than `unsoundAutoMerges` would mean the SHIPPING
   * predicate is unsound too -- a cross-check on the main battery's
   * `unsoundAutoMerges === 0`, from the opposite direction.
   */
  unsoundCaughtBySpatialRule: number;
  /** `unsoundCaughtBySpatialRule === unsoundAutoMerges`: every merge the
   *  ablation broke is one the spatial rule was standing in front of. */
  spatialRuleCatchesAll: boolean;
  /**
   * `unsoundAutoMerges > 0`: the reduced predicate clears at least one pair
   * that does not commute, so the spatial rule is load-bearing FOR THE
   * PREDICATE. It is never load-bearing for the certificate -- the replay
   * backstop refuses those pairs in both modes, and this run's
   * `certificateFailures` is 0 either way. Quote it as replay-cost avoidance
   * (module docstring, "What the spatial rule actually buys"), never as "the
   * certificate would be unsound without it", and never without the
   * derived-cut sensitivity from {@link runDerivedCutSensitivity}.
   */
  spatialRuleIsLoadBearing: boolean;
  certificatesIssued: number;
  certificatesVerified: number;
  certificateFailures: number;
  elapsedMs: number;
}

/**
 * The B4.2 ablation (G4 review item 6): {@link runMergeBattery}'s schedules,
 * generator, seed and op model, with ONE variable changed -- the conflict
 * predicate's spatial half is switched off, so a cross pair conflicts only if
 * its `writtenNodes` intersect.
 *
 * The op model is untouched: hosts still reject openings that escape them and
 * still re-cut lazily. So this measures precisely what the module docstring
 * claims the spatial rule buys -- see the "ablation" section there for how to
 * read a zero as well as a non-zero.
 *
 * Certificate sampling re-verifies under the SAME ablated predicate
 * (`spatialRule: 'disabled'` on the verify options), because a certificate
 * issued under one predicate and re-checked under a stricter one would fail
 * for a reason that has nothing to do with the certificate.
 */
export async function runSpatialAblation(options: MergeBatteryOptions = {}): Promise<SpatialAblationReport> {
  const schedules = options.schedules ?? 1000;
  const seed = options.seed ?? 20260724;
  const epsilonMm = options.epsilonMm ?? DEFAULT_EPSILON_MM;
  const verifyEvery = options.verifyEvery ?? 25;
  const semantics = options.semantics ?? DEFAULT_MERGE_SEMANTICS;
  const generatorSemantics = options.generatorSemantics ?? DEFAULT_MERGE_SEMANTICS;

  const start = performance.now();

  let autoMerged = 0;
  let flaggedConflicts = 0;
  let unsoundApplyFailed = 0;
  let unsoundDiverged = 0;
  let unsoundCaughtBySpatialRule = 0;
  const unsoundScheduleIndices: number[] = [];
  let certificatesIssued = 0;
  let certificatesVerified = 0;
  let certificateFailures = 0;

  for (const { index: s, base, opsA, opsB } of enumerateSchedules(schedules, seed, generatorSemantics)) {
    const outcome = await createCommutationCertificate({
      base,
      opsA,
      opsB,
      epsilonMm,
      clientA: 'client-a',
      clientB: 'client-b',
      spatialRule: 'disabled',
      semantics,
    });

    if (outcome.ok) {
      autoMerged++;
      certificatesIssued++;
      if (verifyEvery > 0 && certificatesIssued % verifyEvery === 0) {
        const verification = await verifyCommutationCertificate(outcome.certificate, base, opsA, opsB, {
          spatialRule: 'disabled',
          semantics,
        });
        certificatesVerified++;
        if (!verification.ok) certificateFailures++;
      }
      continue;
    }

    if (outcome.reason === 'conflict') {
      flaggedConflicts++;
      continue;
    }

    // The predicate approved a pair whose replay failed or diverged. The
    // replay backstop still refuses to emit a certificate; what this counts is
    // the PREDICATE being wrong in the unsafe direction (module docstring).
    unsoundScheduleIndices.push(s);
    if (outcome.reason === 'apply-failed') unsoundApplyFailed++;
    else unsoundDiverged++;
    // Would the SHIPPING predicate have caught it? Only asked on the handful
    // of unsound schedules, so the extra footprint pass costs nothing.
    if (findCrossConflicts(base, opsA, opsB, epsilonMm).length > 0) unsoundCaughtBySpatialRule++;
  }

  const elapsedMs = performance.now() - start;
  const unsoundAutoMerges = unsoundScheduleIndices.length;

  return {
    schedules,
    seed,
    epsilonMm,
    spatialRule: 'disabled',
    semantics,
    generatorSemantics,
    autoMerged,
    flaggedConflicts,
    unsoundAutoMerges,
    unsoundApplyFailed,
    unsoundDiverged,
    unsoundScheduleIndices,
    unsoundCaughtBySpatialRule,
    spatialRuleCatchesAll: unsoundCaughtBySpatialRule === unsoundAutoMerges,
    spatialRuleIsLoadBearing: unsoundAutoMerges > 0,
    certificatesIssued,
    certificatesVerified,
    certificateFailures,
    elapsedMs,
  };
}

/* ------------------------------------------------------------------ */
/* Derived-cut sensitivity: what the 9 decomposes into (G4 item 7)       */
/* ------------------------------------------------------------------ */

/** One cell of the sensitivity grid: the ablation re-scored under one choice
 *  of {@link MergeSemantics}. */
export interface SensitivityVariant {
  /** Short human label, e.g. `'derived cuts + containment off'`. */
  label: string;
  /** Semantics the schedules were scored under. */
  semantics: MergeSemantics;
  /** Semantics the schedule STREAM was generated under. When this differs
   *  from `semantics`, the variant is schedule-MATCHED to the baseline: one
   *  variable changed, and the count is a per-schedule attribution of the
   *  baseline's unsound merges. When it equals `semantics`, the variant is
   *  self-consistent: a different world, not an attribution. */
  generatorSemantics: MergeSemantics;
  /** True when `generatorSemantics` equals `semantics` (see above). */
  schedulesRegenerated: boolean;
  autoMerged: number;
  flaggedConflicts: number;
  /** The number under study: unsound auto-merges with the spatial rule
   *  ablated, under these semantics. */
  unsoundAutoMerges: number;
  unsoundApplyFailed: number;
  unsoundDiverged: number;
  unsoundScheduleIndices: readonly number[];
}

/**
 * The G4 item 7 sensitivity: how much of B4.2's headline "9 unsound
 * auto-merges without the spatial rule" is a property of the two modelling
 * choices in merge-model.ts rather than of the merge problem.
 *
 * The G4 red-team review's claim, stated precisely so it can be right or
 * wrong: the 9 decompose by mechanism into 3 apply-failures from the invented
 * containment invariant and 6 divergences from the stored (lazy) cut, and so
 * "make the cut eager or derived, as IFC and this codebase do" drops the 9 to
 * 3, and dropping containment as well takes it to 1.
 *
 * Method. The **primary** grid ({@link DerivedCutSensitivityReport.matched})
 * holds the SCHEDULE STREAM at the baseline semantics and changes only the
 * semantics the schedules are scored under. That is what makes the numbers an
 * attribution of the SAME 9 events: `generateClientOps` drops candidates its
 * own replica rejects, so regenerating under containment-off would produce
 * different op sets and a count that cannot be lined up against the baseline's
 * schedule indices. The **secondary** grid
 * ({@link DerivedCutSensitivityReport.regenerated}) does regenerate, which
 * answers the different and also fair question "what would the bet have
 * measured if the model had always worked that way". Both are reported,
 * because quoting only the flattering one is the failure mode this whole
 * exercise exists to correct.
 *
 * Nothing here gates: it is a measurement of how load-bearing two modelling
 * choices are, and a sensitivity analysis that could fail an exam would just
 * be an exam.
 */
export interface DerivedCutSensitivityReport {
  schedules: number;
  seed: number;
  epsilonMm: number;
  /** Schedule stream pinned to {@link DEFAULT_MERGE_SEMANTICS}; only the
   *  scoring semantics change. `lazyEnforced` IS the published ablation. */
  matched: {
    lazyEnforced: SensitivityVariant;
    derivedEnforced: SensitivityVariant;
    lazyNoContainment: SensitivityVariant;
    derivedNoContainment: SensitivityVariant;
  };
  /** Schedule stream regenerated under each variant's own semantics. */
  regenerated: {
    derivedEnforced: SensitivityVariant;
    lazyNoContainment: SensitivityVariant;
    derivedNoContainment: SensitivityVariant;
  };
  elapsedMs: number;
}

const SENSITIVITY_CELLS = [
  { key: 'lazyEnforced', label: 'lazy cuts + containment enforced (B4.2 baseline)', cuts: 'lazy', containment: 'enforced' },
  { key: 'derivedEnforced', label: 'derived cuts + containment enforced', cuts: 'derived', containment: 'enforced' },
  { key: 'lazyNoContainment', label: 'lazy cuts + containment off', cuts: 'lazy', containment: 'off' },
  { key: 'derivedNoContainment', label: 'derived cuts + containment off', cuts: 'derived', containment: 'off' },
] as const;

async function runSensitivityCell(
  label: string,
  semantics: MergeSemantics,
  generatorSemantics: MergeSemantics,
  options: { schedules: number; seed: number; epsilonMm: number },
): Promise<SensitivityVariant> {
  const ablation = await runSpatialAblation({
    schedules: options.schedules,
    seed: options.seed,
    epsilonMm: options.epsilonMm,
    // Certificate sampling is off: this run measures the predicate, and
    // re-verifying certificates issued under an ablated predicate AND a
    // variant op model would only re-derive what the run already knows.
    verifyEvery: 0,
    semantics,
    generatorSemantics,
  });
  return {
    label,
    semantics,
    generatorSemantics,
    schedulesRegenerated:
      semantics.cuts === generatorSemantics.cuts && semantics.containment === generatorSemantics.containment,
    autoMerged: ablation.autoMerged,
    flaggedConflicts: ablation.flaggedConflicts,
    unsoundAutoMerges: ablation.unsoundAutoMerges,
    unsoundApplyFailed: ablation.unsoundApplyFailed,
    unsoundDiverged: ablation.unsoundDiverged,
    unsoundScheduleIndices: ablation.unsoundScheduleIndices,
  };
}

/** Run the {@link DerivedCutSensitivityReport} grid. */
export async function runDerivedCutSensitivity(
  options: MergeBatteryOptions = {},
): Promise<DerivedCutSensitivityReport> {
  const schedules = options.schedules ?? 1000;
  const seed = options.seed ?? 20260724;
  const epsilonMm = options.epsilonMm ?? DEFAULT_EPSILON_MM;
  const shared = { schedules, seed, epsilonMm };
  const start = performance.now();

  const matched: Record<string, SensitivityVariant> = {};
  const regenerated: Record<string, SensitivityVariant> = {};
  for (const cell of SENSITIVITY_CELLS) {
    const semantics: MergeSemantics = { cuts: cell.cuts, containment: cell.containment };
    matched[cell.key] = await runSensitivityCell(cell.label, semantics, DEFAULT_MERGE_SEMANTICS, shared);
    if (cell.key === 'lazyEnforced') continue;
    regenerated[cell.key] = await runSensitivityCell(cell.label, semantics, semantics, shared);
  }

  return {
    schedules,
    seed,
    epsilonMm,
    matched: matched as DerivedCutSensitivityReport['matched'],
    regenerated: regenerated as DerivedCutSensitivityReport['regenerated'],
    elapsedMs: performance.now() - start,
  };
}

/* ------------------------------------------------------------------ */
/* Wilson score interval (G4 review item 5)                              */
/* ------------------------------------------------------------------ */

/** z for a two-sided 95% normal interval. */
export const Z_95 = 1.959963984540054;

export interface WilsonInterval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion -- the interval to quote on
 * the restricted false-conflict rate, whose denominator (schedules where the
 * spatial rule fired) is small enough that the normal approximation is
 * misleading and small enough that a bare point estimate oversells its own
 * precision. The G4 red-team review computed [28.2%, 54.7%] for 20/49; this
 * function is what the gate script quotes, and a test pins that value so the
 * number in the report is derived rather than transcribed.
 *
 * Wilson rather than Wald: Wald's interval on 20/49 would be symmetric about
 * the point estimate and can leave [0, 1] entirely for extreme proportions,
 * which is exactly the regime a "zero unsound merges" style claim lives in.
 */
export function wilsonInterval(successes: number, trials: number, z: number = Z_95): WilsonInterval {
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || successes < 0 || trials < 0) {
    throw new Error('@ifc-lite/provenance: wilsonInterval: successes and trials must be non-negative finite numbers');
  }
  if (successes > trials) {
    throw new Error(`@ifc-lite/provenance: wilsonInterval: successes (${successes}) exceeds trials (${trials})`);
  }
  // No trials, no information: the honest interval is the whole range, not a
  // point at zero.
  if (trials === 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}
