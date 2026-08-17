/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP / IFC2x3 / IFC4 source adapter: turn an `IfcDataStore` plus its meshes
 * into representation-agnostic `ClashElement`s, and precompute the
 * void/host/assembly pair exclusions from IFC relationships.
 *
 * This module is the only part of the package that depends on
 * `@ifc-lite/parser` / `@ifc-lite/query`; it is reached via the
 * `@ifc-lite/clash/step` subpath so the core stays version-neutral.
 */

import {
  getInheritanceChainAcrossSchemas,
  isIfcTypeLikeEntity,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { EntityNode } from '@ifc-lite/query';
import type { MeshData } from '@ifc-lite/geometry';
import { makeExclusionSet, qualifiedKey } from '../exclude.js';
import { fromPositions } from '../math/aabb.js';
import type { ClashElement, ExclusionSet, Mat4 } from '../types.js';

/** Minimal federation contract — pass an `@ifc-lite/renderer` `FederationRegistry`. */
export interface FederationLike {
  toGlobalId(modelId: string, expressId: number): number;
}

/**
 * Types that are never physical clash candidates: voids, virtual/reference
 * geometry, and non-product material associations. Including them produced
 * phantom clashes (IfcVirtualElement, IfcOpeningElement, even
 * IfcMaterialConstituent) that no clash rule referenced - they are dropped from
 * the candidate set entirely, so "detect all" and per-rule runs only ever
 * consider real building elements. (#1464)
 *
 * Spatial containers are handled separately by {@link isSpatialContainerTag},
 * which derives them from the schema rather than from a list.
 */
const NON_CLASHABLE_TAGS: ReadonlySet<string> = new Set([
  'IfcOpeningElement',
  'IfcOpeningStandardCase',
  'IfcVirtualElement',
  'IfcGrid',
  'IfcGridAxis',
  'IfcAnnotation',
  'IfcMaterial',
  'IfcMaterialConstituent',
  'IfcMaterialLayer',
]);

/** Memoizes the schema walk below; IFC type names are a bounded vocabulary. */
const spatialContainerByTag = new Map<string, boolean>();

/**
 * True for spatial *containers* - the entities whose geometry describes an
 * extent that, by construction, encloses the elements assigned to it. A storey
 * against the slab it contains is not a coordination problem, and IFC4.3
 * infrastructure exports routinely give IfcBuildingStorey / IfcRoad / IfcBridge
 * tessellated bodies, so every contained element clashed with its own
 * container. (follow-up to #1464)
 *
 * Derived from the schema, not enumerated: `getInheritanceChainAcrossSchemas`
 * walks the bundled IFC2X3 + IFC4 + IFC4X3 union, so the IFC4.3 facility leaves
 * (IfcRoad, IfcBridge, IfcFacilityPart, ...) resolve even though the parser's
 * own codegen pin is IFC4_ADD2_TC1 and would return an empty chain for them.
 * Both supertypes are checked because IFC2X3 has no `IfcSpatialElement` -
 * `IfcSpatialStructureElement` descends straight from `IfcProduct` there.
 * This subsumes the IfcSpace / IfcSpatialZone entries that #1464 listed by hand.
 */
function isSpatialContainerTag(tag: string): boolean {
  const cached = spatialContainerByTag.get(tag);
  if (cached !== undefined) return cached;
  const chain = getInheritanceChainAcrossSchemas(tag);
  const spatial = chain.some(
    (a) => a === 'IfcSpatialElement' || a === 'IfcSpatialStructureElement',
  );
  spatialContainerByTag.set(tag, spatial);
  return spatial;
}

export interface StepAdapterOptions {
  store: IfcDataStore;
  meshes: MeshData[];
  /** Model/file id (federation). */
  modelId: string;
  /** When provided, `ref` is the federated globalId; otherwise the expressId. */
  federation?: FederationLike;
  /**
   * The federation offset the HOST has ALREADY added to every `mesh.expressId`,
   * so this adapter can subtract it back out and address `store` in its own
   * (local) id space. Default 0 — meshes are local.
   *
   * The viewer's loader shifts meshes into the global id space in place
   * (`useIfcLoader`: `mesh.expressId = mesh.expressId + idOffset`) while
   * `IfcDataStore` keeps LOCAL ids, so for every federated model past the first
   * `mesh.expressId` is NOT a key into `store`. Without this, every lookup in
   * the loop below misses: `key` degrades to the synthetic fallback, `tag`
   * reads `Unknown`, name/storey come back empty, and `buildStepExclusions`
   * finds no relationships at all — so void/host/assembly pairs silently stop
   * being excluded. `ref` was wrong in the other direction, with
   * `federation.toGlobalId` adding the offset a second time.
   *
   * `tag` degrades with the rest, despite the `node.type || mesh.ifcType`
   * expression below reading as though the mesh could rescue it: every
   * production `EntityTable` returns the literal string `'Unknown'` from
   * `getTypeName` on a miss, and `'Unknown'` is truthy, so the `mesh.ifcType`
   * arm is unreachable on a store lookup that missed. `Unknown` next to a blank
   * name is the loudest on-screen symptom of this bug.
   *
   * The viewer's own compare path (`lib/compare/buildFingerprints.ts`) does the
   * same subtraction for the same reason. The CLI / MCP / playground callers
   * hand over local meshes and leave this at its `0` default.
   *
   * ## Optional ON PURPOSE — not an oversight
   *
   * The obvious hardening is to make this REQUIRED, and the repo has the
   * precedent: `buildFingerprints.ts` declares `idOffset: number` and does this
   * exact subtraction, which is why compare never had this bug. It is
   * deliberately NOT copied here. `buildFingerprints` is app-internal
   * (`apps/viewer`), free to break at will; `elementsFromStep` is published API
   * — `@ifc-lite/clash` exposes it as the `./step` subpath export — so
   * requiring the member is a breaking change for every external caller, all of
   * which legitimately pass local meshes and would have to add a `0` to keep
   * compiling. That is a major bump to harden one in-repo call site, on a
   * patch-level bugfix.
   *
   * What covers the gap instead, since the optional signature is exactly what
   * let the viewer wiring be deleted and stay green:
   *   - `apps/viewer/src/hooks/useClash.federated-id-offset.test.tsx` pins the
   *     viewer's call at the level that actually broke (it fails if
   *     `meshIdOffset` is dropped from `gatherElements`);
   *   - the total-miss `console.warn` at the end of `elementsFromStep` reports
   *     a forgotten offset at RUNTIME, in any host, including new ones — for
   *     any model whose store actually holds GlobalIds. It stays silent for a
   *     store that holds none (a GLB import), where a total miss is the normal
   *     state and warning would only teach the reader to ignore the message.
   *
   * A dev-only `expressId < 0` assert was considered and rejected: it fires
   * only when the subtrahend is too LARGE, whereas the failure that shipped was
   * a forgotten offset, i.e. a subtrahend of 0 producing positive, plausible,
   * entirely wrong ids. It would not have caught this bug. The total-miss check
   * keys on the damage instead, so it catches both directions.
   */
  meshIdOffset?: number;
  /** Aligns this model into the common world frame (RTC + building rotation). */
  worldTransform?: Mat4;
  /** Precompute void/host/assembly exclusions. Default true. */
  buildExclusions?: boolean;
}

export interface StepAdapterResult {
  elements: ClashElement[];
  exclusions: ExclusionSet;
}

/**
 * Lift local-frame vertices into the model's world frame: `world = origin + local`
 * (the inverse of the renderer's per-element local frame). Returns a fresh f32
 * array; only called when `origin` is non-zero.
 */
function worldFramePositions(local: Float32Array, o: [number, number, number]): Float32Array {
  const out = new Float32Array(local.length);
  for (let i = 0; i + 2 < local.length; i += 3) {
    out[i] = local[i] + o[0];
    out[i + 1] = local[i + 1] + o[1];
    out[i + 2] = local[i + 2] + o[2];
  }
  return out;
}

/**
 * The durable key for an element that has NO stored GlobalId — a malformed /
 * fallback-only IFC root, or every element of a GLB-sourced model, whose store
 * carries geometry and no IFC entities at all.
 *
 * ## Why the model id is in it
 *
 * `key` is the element identity that `clashReviewKey` (`../review.ts`) and the
 * viewer's `elementPairExclusion` (`apps/viewer/src/lib/clash/exclusions.ts`)
 * are BOTH keyed on, and both drop `model` on purpose — in the viewer that is a
 * per-load `crypto.randomUUID()`, so folding it in would make every saved
 * review and every saved rule go inert on the next reload. A GlobalId is
 * globally unique, so that works. An express id is only unique WITHIN a model:
 * every file is numbered from 1, so a bare `expressid:2` names an element in
 * every model of a federation at once, and a review status or an exclusion set
 * on one model's element would silently cover another model's element.
 *
 * ## Why it is encoded
 *
 * `clashReviewKey` composes `rule`, `a.key` and `b.key` with a SPACE, on the
 * stated ground that a space never occurs inside an IfcGUID. A model id is not
 * an IfcGUID — the CLI passes `basename(filePath)` — so it can. Percent-
 * encoding is injective (distinct model ids stay distinct keys) and emits no
 * space, so the separator assumption keeps holding.
 *
 * The `expressid:` prefix is unchanged, and this is a pure fallback: an element
 * WITH a GlobalId is keyed on it exactly as before.
 */
function syntheticKey(modelId: string, expressId: number): string {
  return `expressid:${encodeURIComponent(modelId)}:${expressId}`;
}

/**
 * Whether this store carries ANY GlobalId at all — i.e. whether a total miss
 * says something about the ids we used, or only about the file.
 *
 * Called at most once per `elementsFromStep`, and only on the already-degraded
 * path, so the scan is off every normal run. It short-circuits on the first
 * hit, which is the answer for any real IFC.
 */
function storeHasAnyGlobalId(store: IfcDataStore): boolean {
  const { entities } = store;
  for (let i = 0; i < entities.count; i += 1) {
    if (entities.getGlobalId(entities.expressId[i])) return true;
  }
  return false;
}

export function elementsFromStep(options: StepAdapterOptions): StepAdapterResult {
  const {
    store,
    meshes,
    modelId,
    federation,
    worldTransform,
    buildExclusions = true,
    meshIdOffset = 0,
  } = options;

  const elements: ClashElement[] = [];
  const byExpressId = new Map<number, ClashElement>();
  /** Elements whose GlobalId lookup came back empty — see the check below. */
  let missingGlobalIds = 0;

  for (const mesh of meshes) {
    if (!mesh.positions || mesh.positions.length === 0) continue;
    // STORE-LOCAL id. Everything below that touches `store` — the entity table,
    // `EntityNode`, the relationship graph in `buildStepExclusions` — must use
    // this, never `mesh.expressId`, which the host may already have shifted
    // into the global id space (see `meshIdOffset`).
    const expressId = mesh.expressId - meshIdOffset;
    const node = new EntityNode(store, expressId);

    // Drop non-physical / non-product geometry up front so it never becomes a
    // clash candidate (no rule should have to exclude IfcSpace by hand). (#1464)
    const tag = node.type || mesh.ifcType || 'IfcProduct';
    // Type objects (`IfcWallType`, `IfcSpaceType`, and the `IfcDoorStyle` /
    // `IfcWindowStyle` spelling IFC2X3 uses and IFC4 deprecates)
    // are templates, not occurrences: the mesher turns their `RepresentationMaps`
    // geometry into a mesh that lands on the occurrences instantiating it. That
    // made a type read as a duplicate of its own occurrence, and clash against
    // elements it never physically touches. Dropping them here also closes the
    // gap #1464 left: `IfcSpace` was excluded by name while `IfcSpaceType`
    // sailed straight through. No `IfcProduct` subclass in any supported schema
    // ends in `Type`/`Style`, so this never drops an occurrence. It DOES drop
    // ORPHAN type geometry too (`MeshData.geometryClass === 1`, a type with no
    // occurrence): the viewer's Model view renders that only when the scene has
    // no occurrence geometry at all — a type-library file — and its Types view
    // (which always shows classes 1 and 2) is a catalogue, not a place clash
    // runs from. Clashing origin-stacked templates against each other would be
    // pure noise, so excluding class 1 is the intended reading, not collateral.
    if (
      NON_CLASHABLE_TAGS.has(tag) ||
      isSpatialContainerTag(tag) ||
      isIfcTypeLikeEntity(tag.toUpperCase())
    )
      continue;

    // The wasm geometry path stores positions in the element's LOCAL frame
    // (world = origin + position; see `MeshData.origin`). Clash works in world
    // space — the `ClashElement` contract is world-frame triangles, and the
    // narrow phase is f32-quantized to stay byte-identical with the Rust kernel
    // — so fold the per-element origin into a world-frame positions array here.
    // No-op (shares the input buffer) when origin is absent/zero, e.g. the
    // native/server path or legacy meshing.
    const o = mesh.origin;
    const positions = o && (o[0] !== 0 || o[1] !== 0 || o[2] !== 0)
      ? worldFramePositions(mesh.positions, o)
      : mesh.positions;

    // Read stored (table-backed) values directly. `node.globalId` / `node.name`
    // fall back to `extractEntityAttributesOnDemand` when the table value is
    // empty (common: Name is optional, globalId is empty for fallback-only /
    // malformed roots) — and with a fresh node per mesh that fallback would fire
    // once per element inside this loop (AGENTS.md hot-loop ban). The table
    // getters never trigger on-demand extraction. `node.type` (getTypeName) and
    // `node.storey()` (relationship-only) are table-backed and stay.
    const storedGlobalId = store.entities.getGlobalId(expressId);
    const storedName = store.entities.getName(expressId);

    // Fall back to a MODEL-SCOPED synthetic key rather than dropping geometry:
    // malformed IFC roots, and whole GLB-sourced models, still participate in
    // clashes. See {@link syntheticKey} for why the model id belongs in it.
    const key = storedGlobalId || syntheticKey(modelId, expressId);
    if (!storedGlobalId) missingGlobalIds += 1;

    const element: ClashElement = {
      key,
      // `expressId` is local here, so the offset is applied exactly ONCE and
      // the result is the id the renderer/selection channel already uses for
      // this mesh — i.e. `mesh.expressId` again, whenever `meshIdOffset` and
      // the federation agree (they are both read off the same `model.idOffset`
      // in the viewer). See the federated round-trip test in `step.test.ts`.
      ref: federation ? federation.toGlobalId(modelId, expressId) : expressId,
      model: modelId,
      tag,
      name: storedName || undefined,
      storey: node.storey()?.name || undefined,
      bounds: fromPositions(positions, worldTransform),
      positions,
      indices: mesh.indices,
      transform: worldTransform,
    };

    elements.push(element);
    byExpressId.set(expressId, element);
  }

  // A wrong `meshIdOffset` — above all a FORGOTTEN one — leaves ids that are
  // positive, plausible and simply address the wrong rows, so nothing about an
  // individual id gives it away. Its signature is the SHAPE of the damage:
  // EVERY GlobalId lookup misses, never just some. A real file can carry the
  // occasional fallback-only root with no GlobalId, but "not one element in
  // this model has one" is a host wiring bug, and it is silent otherwise —
  // `key` degrades to the synthetic fallback, `buildStepExclusions` below finds
  // no relationships, and the caller gets a plausible-looking result set with
  // the void/host/assembly exclusions quietly disabled.
  //
  // The `storeHasAnyGlobalId` guard is what keeps that from crying wolf. A
  // total miss means "the ids we used are wrong" only if there was something to
  // hit: a GLB-sourced model has an ENTITY-LESS store
  // (`createMinimalGlbDataStore` -> `createSyntheticDataStore` in the viewer),
  // so EVERY element missing is its normal, correct state, and warning on it
  // would fire on a correct configuration on every run — which teaches people
  // to ignore the one message that reports the real defect. The same goes for a
  // file whose roots carry no GlobalId at all. When the store does hold
  // GlobalIds and not one of our ids reached them, the ids are the problem.
  //
  // One `if` outside the loop, and the scan behind it runs only when the whole
  // model already missed: no per-element cost.
  if (
    elements.length > 0 &&
    missingGlobalIds === elements.length &&
    storeHasAnyGlobalId(store)
  ) {
    console.warn(
      `[clash/step] every element in model "${modelId}" (${elements.length}) resolved to an ` +
        `empty GlobalId. This usually means \`meshIdOffset\` (used: ${meshIdOffset}) does not ` +
        'match the shift the host applied to `mesh.expressId`, so the store is being addressed ' +
        'with ids it does not contain — element keys, names and the void/host exclusions are ' +
        'all degraded.',
    );
  }

  const exclusions = buildExclusions
    ? buildStepExclusions(store, byExpressId)
    : makeExclusionSet();

  return { elements, exclusions };
}

/**
 * Pair-exclusions from IFC relationships. Only relationship getters
 * (`voids`/`filledBy`/`decomposedBy`/`decomposes`) are used here; these read
 * the relationship graph and never call `extractEntityAttributesOnDemand`, so
 * the per-element loop stays off the AGENTS.md hot-loop anti-pattern:
 * - host vs the filler of its opening (wall vs door/window)
 * - element vs its own (meshed) opening
 * - members of the same `IfcRelAggregates` assembly
 */
export function buildStepExclusions(
  store: IfcDataStore,
  byExpressId: Map<number, ClashElement>,
): ExclusionSet {
  const pairs: Array<[string, string]> = [];

  for (const [expressId, element] of byExpressId) {
    const node = new EntityNode(store, expressId);
    const ek = qualifiedKey(element.model, element.key);

    for (const opening of node.voids()) {
      const openingElement = byExpressId.get(opening.expressId);
      if (openingElement) {
        pairs.push([ek, qualifiedKey(openingElement.model, openingElement.key)]);
      }
      for (const filler of opening.filledBy()) {
        const fillerElement = byExpressId.get(filler.expressId);
        if (fillerElement) {
          pairs.push([ek, qualifiedKey(fillerElement.model, fillerElement.key)]);
        }
      }
    }

    const parent = node.decomposedBy();
    if (parent) {
      for (const sibling of parent.decomposes()) {
        if (sibling.expressId === expressId) continue;
        const siblingElement = byExpressId.get(sibling.expressId);
        if (siblingElement) {
          pairs.push([ek, qualifiedKey(siblingElement.model, siblingElement.key)]);
        }
      }
    }
  }

  return makeExclusionSet(pairs);
}
