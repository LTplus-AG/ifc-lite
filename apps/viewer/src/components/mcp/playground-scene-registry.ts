/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-entity book-keeping for the playground scene.
 *
 * One Three.js mesh per tessellated `MeshData` entry — an IFC entity owns one
 * or more of them — plus the lookup maps the agent's tools address them
 * through (expressId / GlobalId / IfcType / storey). Owning this
 * separately from the scene factory keeps the registry — the part every viewer
 * tool touches — readable on its own; `playground-scene.ts` holds the GPU
 * lifecycle and `playground-scene-ops.ts` / `playground-scene-view.ts` hold
 * the operations that read these maps.
 *
 * Why per-entity meshes (not a merged mesh): the agent loop calls things like
 * `viewer_colorize({ global_ids: [...] })` and we need to flip just those
 * entities. Sharing one BufferGeometry would force per-vertex colour
 * attributes + a custom shader pass, which is overkill for the playground
 * scale (≤ ~1k visible entities for the bundled samples).
 */

import * as THREE from 'three';
import type { MeshData } from '@ifc-lite/geometry';
import { EntityNode } from '@ifc-lite/query';
import type { LoadedPlaygroundModel } from './playground-dispatcher';
import type { SectionState } from './playground-scene-view';

export interface EntityRecord {
  expressId: number;
  globalId?: string;
  ifcType?: string;
  storeyName?: string;
  mesh: THREE.Mesh;
  baseColor: THREE.Color;
  baseOpacity: number;
}

/**
 * The record list plus the four lookup maps, all pointing at the same
 * `EntityRecord` objects.
 *
 * Every map values a **list**, because one IFC element routinely tessellates
 * into several `MeshData` entries — one per material, CSG part, or
 * representation item — and `MeshData`'s own contract says to group by
 * `expressId` for per-element operations (`packages/geometry/src/types.ts`).
 * `byExpressId` / `byGlobalId` used to hold a single record and so kept only
 * the LAST submesh, which made id-addressing and type-addressing disagree
 * about the same element: `viewer_isolate({ type })` reached every submesh of
 * a split window while `viewer_colorize({ expressIds })` recoloured one of
 * them (#2443).
 */
export interface EntityRegistry {
  records: EntityRecord[];
  byExpressId: Map<number, EntityRecord[]>;
  byGlobalId: Map<string, EntityRecord[]>;
  byType: Map<string, EntityRecord[]>;
  byStorey: Map<string, EntityRecord[]>;
  /**
   * The `LoadedPlaygroundModel.id` every record here came from, or `null` when
   * the registry is empty. This is the SINGLE-MODEL PRECONDITION (#2471) made
   * explicit — see `buildEntityRecords`, which refuses to break it.
   */
  modelId: string | null;
}

export function createEntityRegistry(): EntityRegistry {
  return {
    records: [],
    byExpressId: new Map<number, EntityRecord[]>(),
    byGlobalId: new Map<string, EntityRecord[]>(),
    byType: new Map<string, EntityRecord[]>(),
    byStorey: new Map<string, EntityRecord[]>(),
    modelId: null,
  };
}

/**
 * How many distinct IFC entities a record set covers.
 *
 * The operations act on every record (that is the whole point of #2443), but
 * they report back to the agent in entities, because that is the unit the
 * agent asked in and the unit the dispatcher's wording promises — it renders
 * these counts as "Painted N entities". Returning `records.length` would
 * answer a one-window `viewer_colorize` with "2" whenever that window
 * tessellated into glass + frame, which is the same id-vs-type disagreement
 * #2443 set out to remove, just moved into the response (#2443 follow-up).
 *
 * A bare `expressId` is a COMPLETE identity here only because the registry
 * holds one model at a time — `expressId` is unique within a STEP file, not
 * across files. `buildEntityRecords` enforces that precondition rather than
 * assuming it, which is what makes this key sound (#2471).
 */
export function countEntities(records: Iterable<EntityRecord>): number {
  const seen = new Set<number>();
  for (const r of records) seen.add(r.expressId);
  return seen.size;
}

/** Append `rec` to the list `key` indexes, creating the list on first use. */
function index<K>(map: Map<K, EntityRecord[]>, key: K, rec: EntityRecord): void {
  const list = map.get(key);
  if (list) list.push(rec);
  else map.set(key, [rec]);
}

/**
 * Whether an alpha value renders translucent — the single predicate behind
 * both `transparent` and `depthWrite`.
 *
 * `buildEntityRecords` derives the pair once at construction; `colorize()` and
 * `reset()` re-derive it later. Those two used to set only `transparent`, so
 * an entity colourised translucent kept `depthWrite: true` and occluded what
 * was behind it, and the mirror case (translucent entity painted opaque) kept
 * `depthWrite: false` and got drawn over. They also disagreed on the
 * threshold — construction tested `a < 1`, the operations `a < 0.999` — so an
 * alpha in between mounted one way and came back the other from a plain
 * `viewer_reset`. One predicate, one place (#2444).
 */
export function isTranslucent(alpha: number): boolean {
  return alpha < 0.999;
}

/** Dispose every mesh + material and empty the registry. */
export function clearEntityRecords(reg: EntityRegistry, modelGroup: THREE.Group): void {
  const { records, byExpressId, byGlobalId, byType, byStorey } = reg;
  for (const r of records) {
    r.mesh.geometry.dispose();
    const mat = r.mesh.material as THREE.Material;
    mat.dispose();
    modelGroup.remove(r.mesh);
  }
  records.length = 0;
  byExpressId.clear();
  byGlobalId.clear();
  byType.clear();
  byStorey.clear();
  // Releasing the model identity is part of emptying the registry: leaving it
  // set would make the next `buildEntityRecords` reject a legitimate model
  // swap, which is the ONE multi-model sequence the playground really performs.
  reg.modelId = null;
}

/**
 * Resolve a tool's selector to the records it addresses.
 *
 * Every branch unions **all** submeshes of a matched element, so addressing
 * one element by id, by GlobalId or by type reaches the same set (#2443).
 */
export function selectTargets(
  reg: EntityRegistry,
  args: { globalIds?: string[]; expressIds?: number[]; type?: string },
): EntityRecord[] {
  const { records, byExpressId, byGlobalId, byType } = reg;
  const out = new Set<EntityRecord>();
  if (args.expressIds) for (const id of args.expressIds) {
    for (const r of byExpressId.get(id) ?? []) out.add(r);
  }
  if (args.globalIds) for (const gid of args.globalIds) {
    for (const r of byGlobalId.get(gid) ?? []) out.add(r);
  }
  if (args.type) {
    // Match by leading IfcType (case-insensitive). The geometry pipeline
    // strips the "Ifc" prefix or upper-cases freely depending on schema,
    // so we tolerate either form.
    const want = args.type.toLowerCase();
    for (const [t, list] of byType) {
      if (t.toLowerCase() === want) for (const r of list) out.add(r);
    }
  }
  if (out.size === 0 && !args.expressIds && !args.globalIds && !args.type) {
    // No targets specified → all
    for (const r of records) out.add(r);
  }
  return Array.from(out);
}

/**
 * Turn a tessellated `MeshData[]` into meshes on `modelGroup` plus registry
 * entries, enriching each with IFC metadata from the parsed store. Returns the
 * opaque/transparent tally the caller logs.
 *
 * **Single-model precondition (#2471).** Every key in this registry is
 * model-unqualified: `byExpressId`, `countEntities`, `colorByProperty`'s
 * per-entity grouping, `byType` and `byStorey` all address entities by a bare
 * value. `expressId` is unique within one STEP file and NOT across files, so
 * two federated models each holding an `#42` would silently merge into one
 * bucket — sampled once, coloured together, counted as one.
 *
 * The `/mcp` playground cannot reach that today, and the reasons are structural
 * rather than accidental: `McpPlayground` holds a single `model` state, its
 * `DispatchContext` never populates `registry`, the `model_load` tool throws
 * `UNSUPPORTED_OPERATION` naming the session single-model, and `loadMeshes`
 * clears the registry before every build. This function turns the last of those
 * from an implicit habit into an enforced invariant: feeding a second model's
 * meshes into a populated registry throws instead of quietly merging.
 *
 * Qualifying the identity everywhere is the alternative, and it is the right
 * fix the day the playground genuinely federates. Until then it would be
 * threading a model id through code paths that provably only ever see one
 * model, so the narrower guarantee is the honest contract.
 */
export function buildEntityRecords(
  reg: EntityRegistry,
  meshes: MeshData[],
  model: LoadedPlaygroundModel,
  modelGroup: THREE.Group,
  section: SectionState,
): { opaqueCount: number; transparentCount: number } {
  const { records, byExpressId, byGlobalId, byType, byStorey } = reg;

  if (reg.modelId !== null && reg.modelId !== model.id) {
    throw new Error(
      `[playground-registry] refusing to federate '${model.id}' into a registry already holding `
      + `'${reg.modelId}': every lookup here keys on a bare expressId, which is unique per file `
      + 'and not across files (#2471). Call clearEntityRecords() first, or qualify the identity.',
    );
  }
  reg.modelId = model.id;

  // Build per-entity records.
  //
  // CRITICAL: side = THREE.DoubleSide for every material, regardless
  // of opacity. The IFC geometry pipeline produces meshes whose
  // triangle winding is INCONSISTENT — some triangles are CCW, some
  // are CW. The native @ifc-lite/renderer pipeline turns culling
  // off everywhere for the same reason (see
  // packages/renderer/src/pipeline.ts:141 — "Disable culling to debug
  // - IFC winding order varies"). Using FrontSide here culls roughly
  // half the triangles per element, which is exactly the
  // "see-through, back faces visible" symptom we hit. DoubleSide
  // costs us a few percent fillrate but renders correctly.
  //
  // We also call computeVertexNormals() defensively in case any
  // mesh's normal buffer is stale or zeroed out — the geometry
  // pipeline writes them but we want to be sure shading reads right.
  let opaqueCount = 0;
  let transparentCount = 0;
  for (const md of meshes) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(md.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(md.normals, 3));
    geom.setIndex(new THREE.BufferAttribute(md.indices, 1));
    // If the supplied normals are degenerate (all zeros), regenerate
    // from the indexed triangles. Cheap if normals were already good.
    const n = md.normals;
    if (n.length === 0 || (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2])) < 1e-6) {
      geom.computeVertexNormals();
    }
    geom.computeBoundingSphere();
    const [r, g, b, a] = md.color;
    const baseColor = new THREE.Color(r, g, b);
    const isTransparent = isTranslucent(a);
    if (isTransparent) transparentCount++; else opaqueCount++;
    const mat = new THREE.MeshStandardMaterial({
      color: baseColor,
      transparent: isTransparent,
      opacity: a,
      side: THREE.DoubleSide, // see comment above
      depthWrite: !isTransparent,
      clippingPlanes: section.planes,
    });
    const mesh = new THREE.Mesh(geom, mat);
    // Geometry buffers stay in the element's local frame for f32 precision;
    // the per-mesh origin (already in the renderer Y-up frame) goes into the
    // mesh transform so world = origin + position — mirroring the renderer's
    // per-batch model-matrix translate. No-op when origin is absent.
    if (md.origin) mesh.position.set(md.origin[0], md.origin[1], md.origin[2]);
    mesh.userData.expressId = md.expressId;
    mesh.userData.ifcType = md.ifcType;
    modelGroup.add(mesh);

    let globalId: string | undefined;
    let ifcType: string | undefined = md.ifcType;
    let storeyName: string | undefined;
    // Resolve more accurate IFC metadata from the parsed store.
    if (model.store.entityIndex.byId.has(md.expressId)) {
      try {
        const node = new EntityNode(model.store, md.expressId);
        globalId = node.globalId || undefined;
        if (!ifcType || ifcType === 'IfcProduct') ifcType = node.type;
        const storey = node.storey();
        if (storey) storeyName = storey.name;
      } catch (err) {
        // Optional metadata enrichment — if EntityNode regresses, fall
        // back to the geometry-derived fields (already populated).
        // Surface at debug level so a real parser issue isn't silent.
        // eslint-disable-next-line no-console
        console.debug('[playground-viewer] EntityNode metadata lookup failed', { expressId: md.expressId, err });
      }
    }

    const rec: EntityRecord = {
      expressId: md.expressId,
      globalId,
      ifcType,
      storeyName,
      mesh,
      baseColor,
      baseOpacity: md.color[3],
    };
    // Every map accumulates: an element with several submeshes must be fully
    // reachable through each of them, not just its last one (#2443).
    records.push(rec);
    index(byExpressId, md.expressId, rec);
    if (globalId) index(byGlobalId, globalId, rec);
    if (ifcType) index(byType, ifcType, rec);
    if (storeyName) index(byStorey, storeyName, rec);
  }

  return { opaqueCount, transparentCount };
}
