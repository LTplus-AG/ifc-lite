/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collaboration slice (M1 scaffolding).
 *
 * Owns the live `CollabSession`, the local ephemeral identity, the resolved
 * access role, and the presence roster. This is the viewer-side counterpart
 * to `@ifc-lite/collab`; see `docs/guide/collaboration.md` for the feature and
 * `docs/architecture/collab-plan.md` for the design.
 *
 * What this scaffolding wires up today:
 *   - identity bootstrap (accountless, persisted handle + color),
 *   - session lifecycle (`startCollab` / `stopCollab`),
 *   - status + presence subscriptions feeding the store.
 *
 * What it deliberately stubs for later milestones (TODOs inline):
 *   - `seedFromStep` model seeding into the Y.Doc (plan §4.2, M1),
 *   - mutation binding + remote→local apply (plan §7.5, M2),
 *   - presence overlay mounting in the viewport (plan §7.4 — done at mount
 *     time in the viewport component, not here).
 */

import type { StateCreator } from 'zustand';
// IMPORTANT: only *type* imports from '@ifc-lite/collab' at module scope. The
// collab runtime (yjs, automerge, providers) is heavy and must stay out of the
// main bundle so the feature ships dark — it is lazy-imported inside
// `startCollab` and code-split into its own chunk.
import type {
  CollabSession,
  LocalPlacement,
  PresenceState,
  ProviderKind,
  StepSeedSource,
  UserIdentity,
  WebSocketStatus,
} from '@ifc-lite/collab';
import type { PropertyValueType } from '@ifc-lite/data';
import type { ViewerState } from '../index.js';
import { collabServerUrl } from '@/lib/collab/config';
import {
  loadOrCreateIdentity,
  persistIdentity,
  type EphemeralIdentity,
} from '@/lib/collab/identity';
import {
  attachRemoteApply,
  mirrorAttribute,
  mirrorEntityDelete,
  mirrorPlacement,
  mirrorProperty,
  mirrorPropertyDelete,
  pathForEntity,
  registerEntityMaps,
  registerEntityPath,
  type CollabDocApi,
} from '@/lib/collab/mutation-bridge';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import {
  buildGeometryResultFromMeshes,
  hydrateGeometryFromRoom,
  seedGeometryToRoom,
  type CollabGeomApi,
} from '@/lib/collab/geometry-sync';
import { createSharedBlobStore } from '@/lib/collab/blob-store';
import {
  attachAnnotationInbound,
  annotationToCrdtFields,
  type AnnotationDocApi,
} from '@/lib/collab/annotation-sync';
import type { Annotation } from '@/store/slices/annotationsSlice';
import { toGlobalIdFromModels } from '../globalId.js';
import { getEntityCenter } from '@/utils/viewportUtils';

/**
 * Access roles, mirrored from `@ifc-lite/collab-server`'s `Role`. Kept as a
 * local type so the viewer doesn't depend on the server package. The role is
 * authoritative on the server (token-derived); the client value only gates
 * UI affordances.
 */
export type CollabRole = 'viewer' | 'commenter' | 'editor' | 'admin';

export type CollabStatus = 'disconnected' | WebSocketStatus | 'memory' | 'indexeddb';

export interface StartCollabOptions {
  /** Room to join. Owner-minted random id, or the `?room=` deep-link value. */
  roomId: string;
  /** Role this client believes it has (server re-checks via the token). */
  role: CollabRole;
  /** Bearer room token forwarded to the collab-server (plan §3.1). */
  token?: string;
  /**
   * Owner-only: lazily produce the model seed (plan §4.6 seed-into-room). Built
   * only when needed and applied only if the room's Y.Doc is still empty, so a
   * recipient joining a populated room hydrates from the doc instead of
   * re-seeding. Recipients (deep-link join) omit this.
   */
  seed?: () => CollabSeedInput | null;
}

/**
 * Model-share payload the owner hands to `startCollab`. Carries the parsed
 * store plus enough context to seed both schema families:
 *   - IFC5/IFCX → seed natively from the store's own IFCX bytes (`store.source`)
 *     and key geometry by IFCX path (`idToPath`), since an IFCX-origin store has
 *     no STEP `entityIndex.byId`/GUIDs to drive `buildStepSeedSource`.
 *   - legacy STEP → seed the pre-built IFCX-shaped `stepSource`, key geometry by
 *     `pathForEntity` (GUID path).
 */
export interface CollabSeedInput {
  /** The active model's parsed store. For IFC5, `store.source` holds the IFCX bytes. */
  store: IfcDataStore;
  /** True when the model is IFC5/IFCX (seed natively from `store.source`). */
  isIfcx: boolean;
  /** Pre-built STEP seed source for legacy rooms; `null` for IFC5. */
  stepSource: StepSeedSource | null;
}

export interface CollabSlice {
  // ── State ────────────────────────────────────────────────────────────────
  /** The live session, or `null` when not in a shared room. */
  collabSession: CollabSession | null;
  /** Connection/persistence status surfaced for the toolbar indicator. */
  collabStatus: CollabStatus;
  /** Current room id, or `null`. */
  collabRoomId: string | null;
  /** This client's resolved role (UI gating only). */
  collabRole: CollabRole | null;
  /** Local ephemeral identity (handle + color). */
  collabIdentity: EphemeralIdentity;
  /** Remote peers currently present (excludes self). */
  collabPeers: PresenceState[];
  /** True while a session is being established. */
  collabConnecting: boolean;
  /** The room token this client joined with (admin for the owner). For minting + revoking links. */
  collabSelfToken: string | null;
  /** The most recently minted share link's token, so an admin can revoke it. */
  collabLastShareToken: string | null;
  /** Room workspace-panel visibility (single-tenant sidebar slot, see registry). */
  collabPanelVisible: boolean;

  // ── Actions ──────────────────────────────────────────────────────────────
  setCollabPanelVisible: (visible: boolean) => void;
  /** Rename / recolor the local identity and persist it. */
  setCollabIdentity: (patch: Partial<Pick<EphemeralIdentity, 'name' | 'color'>>) => void;
  /** Join (or create) a collaborative room. Idempotent: stops any prior session. */
  startCollab: (opts: StartCollabOptions) => Promise<void>;
  /** Leave the current room and tear everything down. */
  stopCollab: () => void;
  /** Record the latest minted share link token (for later revocation). */
  setCollabLastShareToken: (token: string | null) => void;
  /** Admin: invalidate the most recently minted share link. Returns success. */
  revokeCollabLink: () => Promise<boolean>;
  /** Admin: force-disconnect a peer by awareness clientId. Returns success. */
  kickPeer: (clientId: number) => Promise<boolean>;
  /** Whether this client may write the model (editor/admin). */
  canCollabEdit: () => boolean;
  /** Whether this client may write comments (commenter/editor/admin). */
  canCollabComment: () => boolean;

  // ── Mutation mirror (plan §7.5) — called by mutationSlice after a local
  //    edit. No-ops without an active session. ───────────────────────────────
  mirrorPropertyEdit: (
    entityId: number,
    psetName: string,
    propName: string,
    value: unknown,
    valueType: PropertyValueType,
  ) => void;
  mirrorPropertyDelete: (entityId: number, psetName: string, propName: string) => void;
  mirrorAttributeEdit: (entityId: number, attrName: string, value: unknown) => void;
  /**
   * Mirror a geometry move/rotate to the CRDT after a local STEP edit. Composes
   * the IFC-frame translation `deltaIfc` and yaw `deltaYaw` (radians, about Z)
   * onto the entity's current `usd::xformop` (= baseline ∘ cumulative), and
   * records the resulting baked offset so a later *remote* edit computes the
   * right incremental translation rather than re-applying our move (the local
   * mesh was already moved by the STEP edit path).
   */
  mirrorPlacementEdit: (
    modelId: string,
    entityId: number,
    deltaIfc: [number, number, number],
    deltaYaw?: number,
  ) => void;
  /**
   * Read an entity's current local placement from the CRDT (`usd::xformop`),
   * for stores with no STEP placement chain (a recipient's reconstructed IFCX
   * model). Returns null outside a session or when the entity has no placement.
   */
  readCollabPlacement: (entityId: number) => LocalPlacement | null;
  /**
   * Collab-native MOVE for a store with no STEP chain (recipient): composes
   * `deltaIfc` onto the entity's current placement, writes `usd::xformop`,
   * mirrors to peers, and moves the local mesh. Returns true when applied.
   */
  collabTranslateEntity: (entityId: number, deltaIfc: [number, number, number]) => boolean;
  /**
   * Collab-native ROTATE (yaw about Z) for a store with no STEP chain. Composes
   * the yaw onto `usd::xformop`, mirrors to peers, and live-rotates the local
   * mesh about its bbox centre. Returns true when applied.
   */
  collabRotateEntity: (entityId: number, deltaYaw: number) => boolean;
  /**
   * Mirror an entity deletion (tombstone) to the CRDT so peers remove it.
   * Called by mutationSlice after a local removeEntity. No-op without a session
   * or edit rights.
   */
  mirrorEntityRemove: (modelId: string, entityId: number) => void;
  /**
   * Mirror a local element creation (addElement) to the room: creates the
   * entity node + records an identity placement baseline (the mesh blob is
   * baked at the element's world position), and pushes the new mesh as a room
   * blob so peers hydrate + render it. `ifcType` is the builder's STEP-upper
   * type (e.g. 'IFCWALL'); `guid` is the new entity's IFC GlobalId (used to key
   * its room path, since overlay entities aren't in the store's GUID maps);
   * `mesh` is the renderer-frame mesh (or null). No-op without a session/rights.
   */
  mirrorEntityCreate: (
    modelId: string,
    entityId: number,
    ifcType: string,
    guid: string | null,
    mesh: MeshData | null,
  ) => void;
  /**
   * Mirror a geometry-shape change (resize) by replacing the entity's room
   * geometry with a freshly-tessellated `mesh` blob (built at the new world
   * position, so it carries the new size + placement). Resets the entity's
   * placement baseline to identity for the new blob. No-op without a session
   * or edit rights.
   */
  mirrorEntityGeometry: (modelId: string, entityId: number, mesh: MeshData) => void;

  // ── Annotation mirror (collab markup) — called by annotationsSlice after a
  //    local create/edit/delete. No-ops without a session or comment permission.
  mirrorAnnotationUpsert: (annotation: Annotation) => void;
  mirrorAnnotationDelete: (id: string) => void;
}

function pickProvider(): ProviderKind {
  // With a server configured we run both local persistence and live sync;
  // without one we stay local-only (still multi-tab via BroadcastChannel),
  // which is enough to exercise the UI without a backend (plan §5 hosting).
  return collabServerUrl() ? 'indexeddb+websocket' : 'indexeddb';
}

function remotePeers(peers: Record<number, PresenceState>, selfClientId: number): PresenceState[] {
  const out: PresenceState[] = [];
  for (const [clientId, state] of Object.entries(peers)) {
    if (Number(clientId) === selfClientId) continue;
    // Annotate with the awareness clientId so admin actions (kick) can target it.
    out.push({ ...state, clientId: Number(clientId) } as PresenceState);
  }
  return out;
}

/** View a `Uint8Array` as an `ArrayBuffer` (copying only when it's a sub-view). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
    ? (u8.buffer as ArrayBuffer)
    : (u8.slice().buffer as ArrayBuffer);
}

// Collab doc helpers captured from the lazy-loaded runtime (see startCollab),
// so the synchronous mutation mirror can write to the doc without re-importing.
let docApi: CollabDocApi | null = null;
// Placement (move/rotate) helpers captured from the lazy-loaded runtime.
interface PlacementApi {
  getEntityPlacement: (doc: CollabSession['doc'], path: string) => LocalPlacement | null;
  setEntityPlacement: (doc: CollabSession['doc'], path: string, p: LocalPlacement) => void;
  getPlacementBaseline: (doc: CollabSession['doc'], path: string) => LocalPlacement | null;
  setPlacementBaseline: (doc: CollabSession['doc'], path: string, p: LocalPlacement) => void;
}
let placementApi: PlacementApi | null = null;
// Geometry API + a blob-store factory captured at startCollab, so a local
// create (addElement) can push the new entity's mesh blob into the room.
let geomApiRef: CollabGeomApi | null = null;
let makeBlobStore: (() => Promise<Awaited<ReturnType<typeof createSharedBlobStore>>>) | null = null;
let cachedBlobStore: Awaited<ReturnType<typeof createSharedBlobStore>> | null = null;
// Per-session render reconciliation: renderer-frame translation (Y-up) currently
// baked into each entity's live mesh, RELATIVE to its baked baseline. Keyed by
// entity expressId in the active model's id space. Lets inbound placement edits
// push only the *incremental* delta (and avoids re-applying our own edits).
let placementAppliedLoc: Map<number, [number, number, number]> | null = null;
// Companion to placementAppliedLoc: renderer-frame yaw (radians) currently
// baked into each entity's live mesh, relative to its baked baseline.
let placementAppliedYaw: Map<number, number> | null = null;

const PLACEMENT_EPS = 1e-6;
const YAW_EPS = 1e-4;

/** Yaw (radians, about Z) encoded by a placement's refDirection (local +X). */
function yawOf(placement: LocalPlacement | null): number {
  const ref = placement?.refDirection ?? [1, 0, 0];
  return Math.atan2(ref[1], ref[0]);
}

/** Normalize a builder's STEP-uppercase type ('IFCWALL') to IFC case ('IfcWall'). */
function normalizeIfcClass(stepType: string): string {
  if (!stepType.toUpperCase().startsWith('IFC')) return stepType;
  const rest = stepType.slice(3);
  return `Ifc${rest.charAt(0).toUpperCase()}${rest.slice(1).toLowerCase()}`;
}

/**
 * Renderer-frame (Y-up) translation that positions an entity's mesh per
 * `placement`, measured from its baked `baseline`. The mesh is baked at the
 * baseline, so only the difference is applied. IFC is Z-up storey-local; the
 * renderer is Y-up: (x, y, z) → (x, z, -y). (This matches the owner's existing
 * `translateEntity` mapping, and shares its "parent placement is unrotated"
 * simplification — fine for storey-local edits.)
 */
function rendererDeltaForPlacement(
  baseline: LocalPlacement | null,
  placement: LocalPlacement,
): [number, number, number] {
  const bx = baseline?.location[0] ?? 0;
  const by = baseline?.location[1] ?? 0;
  const bz = baseline?.location[2] ?? 0;
  const dx = placement.location[0] - bx;
  const dy = placement.location[1] - by;
  const dz = placement.location[2] - bz;
  return [dx, dz, -dy];
}

/**
 * Compose a placement edit — IFC translation `deltaIfc` + yaw `deltaYaw`
 * (radians about Z) — onto a base placement. Translation accumulates; yaw
 * rotates the refDirection (local +X) in the XY plane.
 */
function composePlacement(
  prev: LocalPlacement,
  deltaIfc: [number, number, number],
  deltaYaw: number,
): LocalPlacement {
  const location: [number, number, number] = [
    prev.location[0] + deltaIfc[0],
    prev.location[1] + deltaIfc[1],
    prev.location[2] + deltaIfc[2],
  ];
  let refDirection = prev.refDirection ?? [1, 0, 0];
  if (deltaYaw !== 0) {
    const yaw = Math.atan2(refDirection[1], refDirection[0]) + deltaYaw;
    refDirection = [Math.cos(yaw), Math.sin(yaw), refDirection[2] ?? 0];
  }
  return { location, axis: prev.axis, refDirection };
}

/**
 * Move an entity's rendered mesh to reflect `placement`, pushing only the
 * *incremental* renderer-frame translation since this client last reconciled
 * it. Shared by inbound remote apply, the recipient's own collab edit, and the
 * owner's track bookkeeping — so own-edits and remote-edits never double-apply.
 */
function reconcilePlacementMesh(
  get: () => ViewerState,
  store: IfcDataStore,
  doc: CollabSession['doc'],
  entityId: number,
  placement: LocalPlacement,
): void {
  if (!placementApi || !placementAppliedLoc || !placementAppliedYaw) return;
  const path = pathForEntity(store, entityId);
  if (!path) return;
  let baseline = placementApi.getPlacementBaseline(doc, path);
  if (!baseline) {
    // No baseline recorded (un-stamped/legacy room) — establish it at the
    // current placement so this edit's delta is measured from where the mesh
    // actually sits. Idempotent; first writer wins.
    baseline = placement;
    placementApi.setPlacementBaseline(doc, path, baseline);
  }
  const modelId = get().activeModelId ?? '';
  const globalId = toGlobalIdFromModels(get().models, modelId, entityId);

  // ── Translation ──
  const target = rendererDeltaForPlacement(baseline, placement);
  const applied = placementAppliedLoc.get(entityId) ?? [0, 0, 0];
  const inc: [number, number, number] = [
    target[0] - applied[0],
    target[1] - applied[1],
    target[2] - applied[2],
  ];
  if (
    Math.abs(inc[0]) >= PLACEMENT_EPS ||
    Math.abs(inc[1]) >= PLACEMENT_EPS ||
    Math.abs(inc[2]) >= PLACEMENT_EPS
  ) {
    get().setPendingMeshTranslations(new Map([[globalId, inc]]));
    placementAppliedLoc.set(entityId, target);
  }

  // ── Rotation (yaw about Z = renderer rotation about +Y, same angle) ──
  // Pivot is the entity's bbox centre in renderer world — identical on every
  // client (same geometry), so the live rotation stays consistent across peers.
  const targetYaw = yawOf(placement) - yawOf(baseline);
  const appliedYaw = placementAppliedYaw.get(entityId) ?? 0;
  const incYaw = targetYaw - appliedYaw;
  if (Math.abs(incYaw) >= YAW_EPS) {
    const meshes = get().geometryResult?.meshes ?? null;
    const c = getEntityCenter(meshes, globalId);
    if (c) {
      get().setPendingMeshRotations(
        new Map([[globalId, { angle: incYaw, pivot: [c.x, c.y, c.z] as [number, number, number] }]]),
      );
      placementAppliedYaw.set(entityId, targetYaw);
    }
  }
}
// Annotation CRDT helpers + inbound-observer teardown (collab markup sync).
let annotationDocApi: AnnotationDocApi | null = null;
let annotationInboundTeardown: (() => void) | null = null;
// Teardown for the remote→local Y.Doc observer.
let remoteApplyTeardown: (() => void) | null = null;
// Teardown for the recipient's live re-reconstruction observer.
let recipientLiveTeardown: (() => void) | null = null;

export const createCollabSlice: StateCreator<ViewerState, [], [], CollabSlice> = (set, get) => ({
  // Initial state
  collabSession: null,
  collabStatus: 'disconnected',
  collabRoomId: null,
  collabRole: null,
  collabIdentity: loadOrCreateIdentity(),
  collabPeers: [],
  collabConnecting: false,
  collabSelfToken: null,
  collabLastShareToken: null,
  collabPanelVisible: false,

  setCollabPanelVisible: (collabPanelVisible) => set({ collabPanelVisible }),

  setCollabIdentity: (patch) => {
    const next: EphemeralIdentity = { ...get().collabIdentity, ...patch };
    persistIdentity(next);
    set({ collabIdentity: next });
    // Reflect the rename into a live session's presence immediately.
    const session = get().collabSession;
    if (session) {
      const user: UserIdentity = { id: next.id, name: next.name, color: next.color };
      session.presence.setUser(user);
    }
  },

  startCollab: async ({ roomId, role, token, seed }) => {
    // Tear down any existing session first (idempotent join).
    get().stopCollab();
    // Set the join token up front (not just at the end): setting collabRoomId
    // re-renders subscribers (e.g. ShareDialog) that immediately mint a
    // role-scoped share link, which needs our admin bearer to be available.
    set({ collabConnecting: true, collabRoomId: roomId, collabRole: role, collabSelfToken: token ?? null });

    // Role gate: joining as viewer/commenter must drop any edit mode the
    // user had on locally — otherwise the gizmo/geometry card would stay
    // visible (and now also rejected at the action level) in a session
    // where they have no edit rights. setEditEnabled re-checks the role.
    if (!get().canCollabEdit()) {
      get().setEditEnabled(false);
    }

    const identity = get().collabIdentity;
    const user: UserIdentity = { id: identity.id, name: identity.name, color: identity.color };

    let session: CollabSession;
    let seedFromStep: typeof import('@ifc-lite/collab')['seedFromStep'];
    let collabMod: typeof import('@ifc-lite/collab');
    try {
      // Lazy-load the collab runtime (code-split) — see the import note above.
      const collab = await import('@ifc-lite/collab');
      collabMod = collab;
      seedFromStep = collab.seedFromStep;
      // Capture the doc helpers the synchronous mutation mirror needs.
      docApi = {
        hasEntity: collab.hasEntity,
        setPropertyValue: collab.setPropertyValue,
        deletePropertyValue: collab.deletePropertyValue,
        setAttribute: collab.setAttribute,
        setEntityPlacement: collab.setEntityPlacement,
        deleteEntity: collab.deleteEntity,
        createEntity: (doc, path, options) => {
          collab.createEntity(doc, path, options);
        },
        XFORMOP_KEY: collab.USD_XFORMOP,
        placementFromXformOp: (value) => {
          const xform = value as { transform?: number[][] } | undefined;
          if (!xform || !Array.isArray(xform.transform)) return null;
          return collab.matrixToPlacement(xform.transform);
        },
        PROPERTY_TYPE_NAMES: collab.PROPERTY_TYPE_NAMES,
      };
      // Placement (move/rotate) helpers + a fresh per-session render-track map.
      placementApi = {
        getEntityPlacement: collab.getEntityPlacement,
        setEntityPlacement: collab.setEntityPlacement,
        getPlacementBaseline: collab.getPlacementBaseline,
        setPlacementBaseline: collab.setPlacementBaseline,
      };
      placementAppliedLoc = new Map();
      placementAppliedYaw = new Map();
      // Capture the annotation (markup) CRDT helpers for the sync bridge.
      annotationDocApi = {
        annotationsMap: (doc) => collab.annotationsMap(doc),
        createAnnotation: (doc, id, fields) => collab.createAnnotation(doc, id, fields),
        deleteAnnotation: (doc, id) => collab.deleteAnnotation(doc, id),
        iterAnnotations: (doc) => collab.iterAnnotations(doc),
      };
      session = await collab.createCollabSession({
        roomId,
        user,
        provider: pickProvider(),
        serverUrl: collabServerUrl() ?? undefined,
        token,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab] failed to start session:', err);
      set({ collabConnecting: false, collabStatus: 'disconnected' });
      return;
    }

    // If a newer start/stop happened while we were awaiting, discard.
    if (get().collabRoomId !== roomId) {
      session.dispose();
      return;
    }

    const selfClientId = session.clientId;
    session.presence.onUpdate((peers) => {
      set({ collabPeers: remotePeers(peers, selfClientId) });
    });
    session.onStatus((status) => set({ collabStatus: status }));
    // Broadcast our role so peers can show it in the roster (advisory; the
    // authoritative role is the server-verified token).
    try {
      session.presence.patch({ role });
    } catch {
      /* cleanup — safe to ignore: presence may not accept the patch in older runtimes */
    }

    const geomApi: CollabGeomApi = {
      createGeometry: (doc, geomId, opts) => collabMod.createGeometry(doc, geomId, opts),
      hasEntity: (doc, path) => collabMod.hasEntity(doc, path),
      addGeometryRef: (doc, path, geomId) => collabMod.addGeometryRef(doc, path, geomId),
      setGeometryRef: (doc, path, ref) => collabMod.setGeometryRef(doc, path, ref),
      getGeometryRef: (doc, path) => collabMod.getGeometryRef(doc, path),
      getGeometry: (doc, geomId) => collabMod.getGeometry(doc, geomId),
      iterEntities: (doc) => collabMod.iterEntities(doc),
    };
    // Expose the geometry API + a blob-store factory so a local create can push
    // the new mesh blob into the room later (not just at seed).
    geomApiRef = geomApi;
    makeBlobStore = () => createSharedBlobStore(collabMod, collabServerUrl(), token);
    cachedBlobStore = null;

    // Owner seeds the model into the Y.Doc (plan §4.6 seed-into-room) once the
    // room has synced — but only if it's still empty, so we don't re-seed a
    // populated room or clobber a peer's edits. Recipients pass no `seed` and
    // hydrate from the doc instead.
    if (seed) {
      try {
        await session.whenSynced;
        if (get().collabRoomId === roomId) {
          const seedData = seed();
          if (seedData) {
            const { store } = seedData;
            // Structure seed — once; never clobber a populated room or peer edits.
            if (session.doc.getMap('entities').size === 0) {
              if (seedData.isIfcx) {
                // IFC5: seed natively from the model's own IFCX bytes. The STEP
                // path (buildStepSeedSource) can't read an IFCX-origin store (no
                // entityIndex.byId / GUIDs) and would seed zero entities.
                const bytes = store.source;
                if (bytes && bytes.length > 0) collabMod.seedFromIfcx(session.doc, bytes);
              } else if (seedData.stepSource) {
                seedFromStep(session.doc, seedData.stepSource);
              }
            }
            // Geometry seed — whenever the room has none yet (DECOUPLED from the
            // entity guard, so a partially-seeded room backfills). Blobs are
            // content-addressed, so re-seeding the same model dedupes.
            if (session.doc.getMap('geometry').size === 0) {
              const blobStore = await createSharedBlobStore(collabMod, collabServerUrl(), token);
              // Record the placement each entity's blob is baked at, so every
              // client (incl. late joiners) can render `blob + (current
              // usd::xformop − baseline)`. The blob is baked at whatever
              // placement the doc holds now: the seeded `usd::xformop` for IFCX
              // models, identity for legacy STEP (geometry baked world-absolute).
              const stampBaseline = (path: string | null): string | null => {
                if (path && placementApi) {
                  const current = placementApi.getEntityPlacement(session.doc, path);
                  placementApi.setPlacementBaseline(session.doc, path, current ?? { location: [0, 0, 0] });
                }
                return path;
              };
              if (seedData.isIfcx && store.source && store.source.length > 0) {
                // IFCX geometry is explicit in the file: re-parse the source for
                // COMPLETE meshes + the id→path map to key them. (The owner's
                // render buffers may be memory-released for large models, so we
                // never read those for seeding — plan Fix 2.)
                const { parseIfcxViewerModel } = await import('@/hooks/ingest/viewerModelIngest');
                const parsed = await parseIfcxViewerModel(toArrayBuffer(store.source), undefined, {
                  allowEmptyGeometry: true,
                });
                if (parsed.idToPath && parsed.pathToId) {
                  // Let the owner's outbound mirror resolve paths on this IFCX store.
                  registerEntityMaps(store, parsed.idToPath, parsed.pathToId);
                }
                const meshes = parsed.geometryResult.meshes;
                if (meshes.length > 0) {
                  await seedGeometryToRoom(geomApi, session, blobStore, meshes, (id) =>
                    stampBaseline(parsed.idToPath?.get(id) ?? null),
                  );
                }
              } else {
                const meshes = get().geometryResult?.meshes;
                if (meshes && meshes.length > 0) {
                  await seedGeometryToRoom(geomApi, session, blobStore, meshes, (id) =>
                    stampBaseline(pathForEntity(store, id)),
                  );
                }
              }
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] model seeding failed:', err);
      }
    } else {
      // Recipient (deep-link join, no local model): reconstruct the full model
      // from the CRDT as IFCX — the canonical format — then attach geometry
      // hydrated from the room's blobs. IFC5 rooms carry containment +
      // properties natively; legacy STEP rooms are seeded IFCX-shaped too (see
      // `buildStepSeedSource`), so this single path serves both. The renderer
      // and panels then use the standard legacy single-model path
      // (`ifcDataStore` + `geometryResult`). Best-effort — blobs may still be
      // syncing; a later re-join picks up the rest.
      try {
        await session.whenSynced;
        // Reconstruct the IfcDataStore (entities + spatial hierarchy +
        // properties) from the CRDT-as-IFCX via the viewer's existing importer.
        // Loaded lazily so the collab feature stays code-split.
        const { parseIfcxViewerModel } = await import('@/hooks/ingest/viewerModelIngest');
        const blobStore = await createSharedBlobStore(collabMod, collabServerUrl(), token);
        let lastGeomCount = -1;
        let reconstructing = false;
        // Decoded-mesh cache (geomId → mesh), persisted across re-reconstructs so
        // a later doc update only fetches the *new* blobs, not the whole model.
        const geomCache = new Map<string, MeshData>();
        // The recipient is registered as a real model (not the bare legacy store
        // path) so it gets an activeModelId + an editable MutablePropertyView —
        // which is what lets a recipient's edits flow back to the owner.
        const roomModelId = `room:${roomId}`;
        let modelCreated = false;

        // Re-derive the whole model from the doc. Cheap metadata refresh always;
        // geometry is re-hydrated from blobs only when the geometry set changed
        // (so a peer's property edit doesn't re-fetch every mesh).
        const reconstruct = async () => {
          if (reconstructing || get().collabRoomId !== roomId) return;
          reconstructing = true;
          try {
            const ifcxFile = collabMod.snapshotToIfcx(session.doc);
            const buffer = new TextEncoder().encode(JSON.stringify(ifcxFile)).buffer as ArrayBuffer;
            const payload = await parseIfcxViewerModel(buffer, undefined, { allowEmptyGeometry: true });
            if (get().collabRoomId !== roomId) return;
            // Register the IFCX path maps so the recipient's outbound mirror and
            // inbound apply can resolve entity↔path (the reconstructed store has
            // no STEP `entityIndex.byId`). Without this, recipient edits don't sync.
            if (payload.idToPath && payload.pathToId) {
              registerEntityMaps(payload.dataStore, payload.idToPath, payload.pathToId);
            }
            if (!modelCreated) {
              // First build: register a real model record (like a normal file
              // load), giving the recipient an activeModelId + selection that
              // resolves to a model (not 'legacy') so PropertiesPanel registers an
              // editable MutablePropertyView. idOffset 0 — mesh expressIds are
              // already in the reconstructed store's id space.
              modelCreated = true;
              let maxExpressId = 0;
              if (payload.idToPath) {
                for (const id of payload.idToPath.keys()) if (id > maxExpressId) maxExpressId = id;
              }
              get().upsertModel({
                id: roomModelId,
                name: 'Shared model',
                ifcDataStore: payload.dataStore,
                geometryResult: payload.geometryResult,
                visible: true,
                collapsed: false,
                schemaVersion: payload.schemaVersion,
                loadedAt: Date.now(),
                fileSize: 0,
                idOffset: 0,
                maxExpressId,
                loadState: 'complete',
              });
            } else {
              // Re-derivation on a peer edit: refresh the active model's store in
              // place (keeps the model id + activeModelId stable). setIfcDataStore
              // also updates the global store the outbound mirror reads.
              get().setIfcDataStore(payload.dataStore);
            }
            const geomCount = session.doc.getMap('geometry').size;
            if (geomCount !== lastGeomCount) {
              lastGeomCount = geomCount;
              // Re-key meshes into the reconstructed id space (pathToId) so 3D
              // selection resolves to the right inspector entry. Blobs are
              // fetched in parallel (cached by geomId) and rendered incrementally
              // via onProgress so a large model fills in progressively instead of
              // staying blank until every blob arrives.
              const meshes = await hydrateGeometryFromRoom(
                geomApi,
                session,
                blobStore,
                payload.pathToId,
                {
                  cache: geomCache,
                  onProgress: (soFar) => {
                    if (get().collabRoomId === roomId && soFar.length > 0) {
                      get().setGeometryResult(buildGeometryResultFromMeshes(soFar.slice()));
                    }
                  },
                },
              );
              if (geomCount > 0 && meshes.length === 0) {
                // eslint-disable-next-line no-console
                console.warn(
                  `[collab] recipient: room has ${geomCount} geometry record(s) but 0 meshes hydrated — ` +
                    'blobs may still be syncing, or the owner seeded a room with no geometry.',
                );
              }
              if (get().collabRoomId === roomId) {
                get().setGeometryResult(
                  meshes.length > 0 ? buildGeometryResultFromMeshes(meshes) : payload.geometryResult,
                );
              }
            }
          } finally {
            reconstructing = false;
          }
        };

        // Initial build (only when we don't already have a local model).
        if (get().collabRoomId === roomId && !get().ifcDataStore) {
          await reconstruct();
        }

        // Live updates: re-reconstruct (debounced) whenever a peer edits the doc.
        let debounceHandle: ReturnType<typeof setTimeout> | null = null;
        const onDocUpdate = () => {
          if (debounceHandle) clearTimeout(debounceHandle);
          debounceHandle = setTimeout(() => {
            void reconstruct();
          }, 800);
        };
        session.doc.on('update', onDocUpdate);
        recipientLiveTeardown = () => {
          if (debounceHandle) clearTimeout(debounceHandle);
          try {
            session.doc.off('update', onDocUpdate);
          } catch {
            /* cleanup — safe to ignore */
          }
          // Drop the reconstructed room model on leave so rejoining a different
          // room doesn't accumulate stale `room:*` models. (Only the recipient
          // path creates this; the owner shares its own local model.)
          if (modelCreated) {
            try {
              get().removeModel(roomModelId);
            } catch {
              /* cleanup — safe to ignore */
            }
          }
        };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] model reconstruction failed:', err);
      }
    }

    // Remote → local apply (plan §7.5): replay peers' property/attribute edits
    // into the active model's MutablePropertyView (no undo tracking, no echo).
    // The active model is resolved *per event* (not captured once) so switching
    // models mid-session targets the currently-active view, not a stale one.
    const applyStore = get().ifcDataStore;
    if (applyStore) {
      const activeView = () => {
        const modelId = get().activeModelId;
        return modelId ? get().mutationViews.get(modelId) : undefined;
      };
      remoteApplyTeardown = attachRemoteApply(docApi!, session, applyStore, {
        onProperty: (entityId, pset, prop, value, type) => {
          const view = activeView();
          if (!view) return;
          view.setProperty(entityId, pset, prop, value, type);
          set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
        },
        onPropertyDelete: (entityId, pset, prop) => {
          const view = activeView();
          if (!view) return;
          view.deleteProperty(entityId, pset, prop);
          set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
        },
        onAttribute: (entityId, attrName, value) => {
          const view = activeView();
          if (!view) return;
          view.setAttribute(entityId, attrName, value === null ? '' : String(value));
          set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
        },
        // A peer moved/rotated an entity: reflect it on the local mesh by
        // pushing the incremental renderer-frame delta (no undo, no echo).
        onPlacement: (entityId, placement) => {
          reconcilePlacementMesh(get, applyStore, session.doc, entityId, placement);
          set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
        },
        // A peer deleted an entity: hide its mesh (matches the owner's local
        // removeEntity, which hides rather than destroying GPU buffers).
        onEntityDelete: (entityId) => {
          const modelId = get().activeModelId ?? '';
          const globalId = toGlobalIdFromModels(get().models, modelId, entityId);
          get().hideEntities([globalId]);
          set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
        },
      });
    }

    // Annotation (markup) sync: reflect peers' pins into the local slice, and
    // seed our existing local pins into the room ("share existing + new").
    if (annotationDocApi) {
      try {
        annotationInboundTeardown = attachAnnotationInbound(session, annotationDocApi, {
          myId: () => get().collabIdentity.id,
          getLocal: () => get().annotations,
          upsertRemote: (a) => get().upsertRemoteAnnotation(a),
          removeRemote: (id) => get().removeRemoteAnnotation(id),
        });
        if (get().canCollabComment()) {
          for (const a of get().annotations.values()) {
            if (!a.remote) get().mirrorAnnotationUpsert(a);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] annotation sync setup failed:', err);
      }
    }

    set({
      collabSession: session,
      collabStatus: session.status(),
      collabConnecting: false,
      collabSelfToken: token ?? null,
    });
  },

  stopCollab: () => {
    if (remoteApplyTeardown) {
      try {
        remoteApplyTeardown();
      } catch {
        /* cleanup — safe to ignore */
      }
      remoteApplyTeardown = null;
    }
    if (recipientLiveTeardown) {
      try {
        recipientLiveTeardown();
      } catch {
        /* cleanup — safe to ignore */
      }
      recipientLiveTeardown = null;
    }
    if (annotationInboundTeardown) {
      try {
        annotationInboundTeardown();
      } catch {
        /* cleanup — safe to ignore */
      }
      annotationInboundTeardown = null;
    }
    docApi = null;
    annotationDocApi = null;
    placementApi = null;
    placementAppliedLoc = null;
    placementAppliedYaw = null;
    geomApiRef = null;
    makeBlobStore = null;
    cachedBlobStore = null;
    const session = get().collabSession;
    if (session) {
      try {
        session.dispose();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] error disposing session:', err);
      }
    }
    set({
      collabSession: null,
      collabStatus: 'disconnected',
      collabRoomId: null,
      collabRole: null,
      collabPeers: [],
      collabConnecting: false,
      collabSelfToken: null,
      collabLastShareToken: null,
      collabPanelVisible: false,
    });
  },

  setCollabLastShareToken: (token) => set({ collabLastShareToken: token }),

  revokeCollabLink: async () => {
    const shareToken = get().collabLastShareToken;
    const adminToken = get().collabSelfToken;
    if (!shareToken || !adminToken) return false;
    try {
      const { revokeRoomToken } = await import('@/lib/collab/share-link');
      return await revokeRoomToken(shareToken, adminToken);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab] revoke link failed:', err);
      return false;
    }
  },

  kickPeer: async (clientId) => {
    const roomId = get().collabRoomId;
    const adminToken = get().collabSelfToken;
    if (!roomId || !adminToken) return false;
    try {
      const { kickRoomPeer } = await import('@/lib/collab/share-link');
      return await kickRoomPeer(roomId, clientId, adminToken);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab] kick peer failed:', err);
      return false;
    }
  },

  canCollabEdit: () => {
    const role = get().collabRole;
    // Not in a shared room → fall back to the local single-user editing rules
    // (handled by the UI's existing `editEnabled` gate), so treat as allowed.
    if (role === null) return true;
    return role === 'editor' || role === 'admin';
  },

  canCollabComment: () => {
    const role = get().collabRole;
    if (role === null) return true;
    return role === 'commenter' || role === 'editor' || role === 'admin';
  },

  mirrorPropertyEdit: (entityId, psetName, propName, value, valueType) => {
    const session = get().collabSession;
    const store = get().ifcDataStore;
    if (!session || !store || !docApi) return;
    mirrorProperty(docApi, session, store, entityId, psetName, propName, value, valueType);
  },

  mirrorPropertyDelete: (entityId, psetName, propName) => {
    const session = get().collabSession;
    const store = get().ifcDataStore;
    if (!session || !store || !docApi) return;
    mirrorPropertyDelete(docApi, session, store, entityId, psetName, propName);
  },

  mirrorAttributeEdit: (entityId, attrName, value) => {
    const session = get().collabSession;
    const store = get().ifcDataStore;
    if (!session || !store || !docApi) return;
    mirrorAttribute(docApi, session, store, entityId, attrName, value);
  },

  mirrorPlacementEdit: (modelId, entityId, deltaIfc, deltaYaw = 0) => {
    const session = get().collabSession;
    const store = get().models.get(modelId)?.ifcDataStore ?? get().ifcDataStore;
    if (!session || !store || !docApi || !placementApi || !placementAppliedLoc) return;
    if (!get().canCollabEdit()) return;
    const path = pathForEntity(store, entityId);
    if (!path) return;
    const baseline = placementApi.getPlacementBaseline(session.doc, path);
    const prev =
      placementApi.getEntityPlacement(session.doc, path) ?? baseline ?? { location: [0, 0, 0] };
    const next = composePlacement(prev, deltaIfc, deltaYaw);
    mirrorPlacement(docApi, session, store, entityId, next);
    // The local mesh was already moved/rotated by the edit path; record the
    // resulting baked offset + yaw so we don't double-apply on a later remote
    // edit (and so a remote edit computes the correct incremental).
    placementAppliedLoc.set(entityId, rendererDeltaForPlacement(baseline, next));
    if (placementAppliedYaw) placementAppliedYaw.set(entityId, yawOf(next) - yawOf(baseline));
  },

  readCollabPlacement: (entityId) => {
    const session = get().collabSession;
    const store = get().ifcDataStore;
    if (!session || !store || !placementApi || !docApi) return null;
    const path = pathForEntity(store, entityId);
    if (!path || !docApi.hasEntity(session.doc, path)) return null;
    // Any entity that exists in the room is movable: prefer its live placement,
    // then its baked baseline, then identity. Returning identity (not null) for
    // an un-edited / un-stamped entity is what lets the gizmo render on a
    // recipient — the gizmo's origin comes from the mesh bbox, and a later edit
    // establishes the baseline lazily (see `reconcilePlacementMesh`).
    return (
      placementApi.getEntityPlacement(session.doc, path) ??
      placementApi.getPlacementBaseline(session.doc, path) ?? { location: [0, 0, 0] }
    );
  },

  collabTranslateEntity: (entityId, deltaIfc) => {
    const session = get().collabSession;
    const store = get().ifcDataStore;
    if (!session || !store || !docApi || !placementApi) return false;
    if (!get().canCollabEdit()) return false;
    const path = pathForEntity(store, entityId);
    if (!path) return false;
    const prev =
      placementApi.getEntityPlacement(session.doc, path) ??
      placementApi.getPlacementBaseline(session.doc, path) ?? { location: [0, 0, 0] };
    const next: LocalPlacement = {
      location: [
        prev.location[0] + deltaIfc[0],
        prev.location[1] + deltaIfc[1],
        prev.location[2] + deltaIfc[2],
      ],
      axis: prev.axis,
      refDirection: prev.refDirection,
    };
    mirrorPlacement(docApi, session, store, entityId, next);
    // No STEP chain on this store — move our own mesh via the shared reconciler.
    reconcilePlacementMesh(get, store, session.doc, entityId, next);
    return true;
  },

  collabRotateEntity: (entityId, deltaYaw) => {
    const session = get().collabSession;
    const store = get().ifcDataStore;
    if (!session || !store || !docApi || !placementApi) return false;
    if (!get().canCollabEdit()) return false;
    const path = pathForEntity(store, entityId);
    if (!path) return false;
    const prev =
      placementApi.getEntityPlacement(session.doc, path) ??
      placementApi.getPlacementBaseline(session.doc, path) ?? { location: [0, 0, 0] };
    const next = composePlacement(prev, [0, 0, 0], deltaYaw);
    mirrorPlacement(docApi, session, store, entityId, next);
    // Live-rotate our own mesh via the shared reconciler (rotation branch).
    reconcilePlacementMesh(get, store, session.doc, entityId, next);
    return true;
  },

  mirrorEntityRemove: (modelId, entityId) => {
    const session = get().collabSession;
    const store = get().models.get(modelId)?.ifcDataStore ?? get().ifcDataStore;
    if (!session || !store || !docApi) return;
    if (!get().canCollabEdit()) return;
    mirrorEntityDelete(docApi, session, store, entityId);
    // Drop any placement tracking for the removed entity.
    placementAppliedLoc?.delete(entityId);
    placementAppliedYaw?.delete(entityId);
  },

  mirrorEntityCreate: (modelId, entityId, ifcType, guid, mesh) => {
    const session = get().collabSession;
    const store = get().models.get(modelId)?.ifcDataStore ?? get().ifcDataStore;
    if (!session || !store || !docApi || !placementApi || !geomApiRef) return;
    if (!get().canCollabEdit()) return;
    // Overlay (runtime-created) entities aren't in the store's GUID maps, so
    // derive the path from the new entity's GlobalId and register it so this
    // (and later edits to it) resolve.
    let path = pathForEntity(store, entityId);
    if (!path && guid) {
      path = `/${guid}`;
      registerEntityPath(store, entityId, path);
    }
    if (!path) return;
    const ifcClass = normalizeIfcClass(ifcType);
    const api = docApi;
    session.transact(() => {
      api.createEntity(session.doc, path, {
        ifcClass,
        attributes: { 'bsi::ifc::class': { code: ifcClass } },
      });
    });
    // The mesh blob is baked at the element's world position → identity baseline
    // (so a later move composes correctly; see reconcilePlacementMesh).
    placementApi.setPlacementBaseline(session.doc, path, { location: [0, 0, 0] });
    // Push the new mesh as a room blob so peers hydrate + render it. Async,
    // fire-and-forget — the local element already rendered.
    if (mesh && makeBlobStore) {
      const geom = geomApiRef;
      void (async () => {
        try {
          cachedBlobStore = cachedBlobStore ?? (await makeBlobStore!());
          await seedGeometryToRoom(geom, session, cachedBlobStore, [mesh], () => path);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[collab] mirror create geometry failed:', err);
        }
      })();
    }
  },

  mirrorEntityGeometry: (modelId, entityId, mesh) => {
    const session = get().collabSession;
    const store = get().models.get(modelId)?.ifcDataStore ?? get().ifcDataStore;
    if (!session || !store || !geomApiRef || !makeBlobStore) return;
    if (!get().canCollabEdit()) return;
    const path = pathForEntity(store, entityId);
    if (!path) return;
    // The new mesh is baked at the entity's current world position (identity
    // baseline, set at create/seed). Reset applied tracking so the fresh blob
    // is treated as the new zero (resize-after-move on a peer is an accepted v1
    // limitation — the peer's stale applied delta isn't reset remotely).
    placementAppliedLoc?.delete(entityId);
    placementAppliedYaw?.delete(entityId);
    const geom = geomApiRef;
    void (async () => {
      try {
        cachedBlobStore = cachedBlobStore ?? (await makeBlobStore!());
        await seedGeometryToRoom(geom, session, cachedBlobStore, [mesh], () => path, { replace: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] mirror resize geometry failed:', err);
      }
    })();
  },

  mirrorAnnotationUpsert: (annotation) => {
    const session = get().collabSession;
    if (!session || !annotationDocApi || !get().canCollabComment()) return;
    const api = annotationDocApi;
    session.transact(() => api.createAnnotation(session.doc, annotation.id, annotationToCrdtFields(annotation)));
  },

  mirrorAnnotationDelete: (id) => {
    const session = get().collabSession;
    if (!session || !annotationDocApi || !get().canCollabComment()) return;
    const api = annotationDocApi;
    session.transact(() => api.deleteAnnotation(session.doc, id));
  },
});
