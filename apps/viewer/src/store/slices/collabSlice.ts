/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collaboration slice (M1 scaffolding).
 *
 * Owns the live `CollabSession`, the local ephemeral identity, the resolved
 * access role, and the presence roster. This is the viewer-side counterpart
 * to `@ifc-lite/collab`; see `docs/guide/collaboration.md` for the feature and
 * `docs/architecture/collaboration.md` for the design.
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
  ModelSlotRef,
  PresenceState,
  ProviderKind,
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
  type CollabDocApi,
} from '@/lib/collab/mutation-bridge';
import { pathForEntity, pathForGuid, registerEntityPath } from '@/lib/collab/entity-paths';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { seedGeometryToRoom, type CollabGeomApi } from '@/lib/collab/geometry-sync';
import { runOwnerSeed, type CollabSeedInput } from '@/lib/collab/owner-seed';
import type { CollabSeedPhase, CollabSeedProgress } from '@/lib/collab/seed-phase';
import { createSharedBlobStore } from '@/lib/collab/blob-store';
import {
  roomEntityTargetForPath,
  roomMeshesFor,
  roomMutationViewFor,
  roomStoreFor,
} from '@/lib/collab/room-model-target';
import { roomSlotRef } from '@/lib/collab/model-slot-ref';
import { createRoomReconstructor } from '@/lib/collab/room-reconstruct';
import {
  PLACEMENT_EPS,
  YAW_EPS,
  rendererDeltaForPlacement,
  yawOf,
  type PlacementSweepApi,
} from '@/lib/collab/placement-sweep';
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

/**
 * The single role -> edit rule. `canCollabEdit()` below is its store-bound
 * form, and components that mirror the same gate in their own UI
 * (`BulkPropertyEditor`, `DataConnector`) call this directly off `collabRole`.
 * Keeping one body means a future role change cannot drift the copies apart.
 * `null` = not in a shared room, so the local single-user editing rules apply
 * (handled by the UI's existing `editEnabled` gate) and this returns true.
 */
export function roleCanEdit(role: CollabRole | null): boolean {
  if (role === null) return true;
  return role === 'editor' || role === 'admin';
}

export type CollabStatus = 'disconnected' | WebSocketStatus | 'memory' | 'indexeddb';

export interface StartCollabOptions {
  /** Room to join. Owner-minted random id, or the `?room=` deep-link value. */
  roomId: string;
  /** Role this client believes it has (server re-checks via the token). */
  role: CollabRole;
  /** Bearer room token forwarded to the collab-server (plan §3.1). */
  token?: string;
  /**
   * Owner-only: the models to seed (plan §4.6 seed-into-room), one room slot
   * each, in this order. Applied only to slots the room does not hold yet, so
   * a recipient joining a populated room hydrates from the doc instead of
   * re-seeding. Recipients (deep-link join) omit this. The room's slots are
   * recorded from this list synchronously, before any await — which is why
   * it is a value, not a thunk.
   */
  seed?: CollabSeedInput;
}

export type { CollabSeedInput, CollabSeedModel } from '@/lib/collab/owner-seed';

export interface CollabSlice {
  // ── State ────────────────────────────────────────────────────────────────
  /** The live session, or `null` when not in a shared room. */
  collabSession: CollabSession | null;
  /** Connection/persistence status surfaced for the toolbar indicator. */
  collabStatus: CollabStatus;
  /** Current room id, or `null`. */
  collabRoomId: string | null;
  /**
   * The models this room's edits belong to — viewer model id → room slot —
   * fixed for the session: the models the owner seeded (the share scope), or
   * the recipient's reconstructed `room:<roomId>:<slotId>` models, one per
   * slot (#4444). Empty off a session (and for an owner who pressed Share
   * with nothing to seed).
   *
   * Both edit directions used to resolve the room's model as "whatever is
   * active", which is wrong the moment the user loads a second file:
   * `upsertModel` does not switch focus (modelSlice.ts). See
   * `@/lib/collab/room-model-target`, which is the only thing allowed to
   * answer this question, so the two directions cannot disagree again.
   *
   * KNOWN GAP — this goes stale if a room model is removed mid-session.
   * `removeModel` (modelSlice.ts) purges every other dangling reference to a
   * removed model (mutation views, undo stacks, source tags, clash focus, IDS
   * report, selection, activeStorey) but not this one. The session then fails
   * CLOSED and silently for that model: `roomStoreFor` finds no model for the
   * id, so its inbound peer events are all dropped and every outbound mirror
   * is dead, while RoomPanel still shows the room as live. Unrecoverable
   * without a rejoin.
   *
   * Do NOT "fix" this by dropping the entry on removal. `isRoomModel` falls
   * back to `activeModelId` only OFF a session — that fallback exists for the
   * no-session case — so a live session with an emptied map fails closed,
   * which is strictly better than retargeting to whatever the user has
   * selected, the corruption this whole module exists to prevent. A real fix
   * has to decide what removing a shared model MEANS (end the session? refuse
   * the removal?), which is a product question, so it is recorded here rather
   * than guessed at.
   */
  collabRoomModels: ReadonlyMap<string, ModelSlotRef>;
  /** This client's resolved role (UI gating only). */
  collabRole: CollabRole | null;
  /** Local ephemeral identity (handle + color). */
  collabIdentity: EphemeralIdentity;
  /** Remote peers currently present (excludes self). */
  collabPeers: PresenceState[];
  /**
   * Full-doc fork point for session-draft publishing (#1717): captured
   * once the session is synced/seeded, re-captured after each publish so
   * the next layer carries only new edits.
   */
  collabDraftBaseline: Uint8Array | null;
  /**
   * True when peers were present at ANY point since the draft baseline —
   * a peer who edited and left must still stamp the published layer
   * `author.kind: hybrid`; sampling live presence at publish time would
   * misattribute their edits.
   */
  collabPeersSinceBaseline: boolean;
  /** True while a session is being established. */
  collabConnecting: boolean;
  /** The room token this client joined with (admin for the owner). For minting + revoking links. */
  collabSelfToken: string | null;
  /** The most recently minted share link's token, so an admin can revoke it. */
  collabLastShareToken: string | null;
  /** Room workspace-panel visibility (single-tenant sidebar slot, see registry). */
  collabPanelVisible: boolean;
  /**
   * Why this room's geometry seed did not fully land, or null when it did (or
   * when the model legitimately had no geometry to seed). Sticky for the life
   * of the session so the Share dialog cannot hand out a link to a room it
   * knows is missing its geometry and still call that success.
   */
  collabSeedFailure: string | null;
  /**
   * Where the owner's initial seed-into-room stands (#4446). A connected
   * websocket is NOT a seeded room: `collabStatus` reads 'connected' while
   * structure and geometry are still uploading, and `collabRoomId` is set
   * before either begins. The Share dialog holds the invite back until this
   * settles; RoomPanel says "uploading" rather than "live". `'none'` off a
   * session and for recipients, who never seed. Reset by `stopCollab`.
   */
  collabSeedPhase: CollabSeedPhase;
  /** Geometry blob uploads so far while `collabSeedPhase === 'geometry'`, else `null`. */
  collabSeedProgress: CollabSeedProgress | null;
  /**
   * One-shot message for the toast channel: a joined room that hydrated with
   * entities but no meshes, or a local edit whose mesh never reached the room.
   * Consumed (and cleared) by the layout, so the store stays free of UI
   * imports (slices set state, components toast).
   */
  collabGeometryNotice: string | null;

  // ── Actions ──────────────────────────────────────────────────────────────
  setCollabPanelVisible: (visible: boolean) => void;
  /** Rename / recolor the local identity and persist it. */
  setCollabIdentity: (patch: Partial<Pick<EphemeralIdentity, 'name' | 'color'>>) => void;
  /** Join (or create) a collaborative room. Idempotent: stops any prior session. */
  startCollab: (opts: StartCollabOptions) => Promise<void>;
  /** Leave the current room and tear everything down. */
  stopCollab: () => void;
  /** Re-capture the session-draft fork point (after a publish). */
  resetCollabDraftBaseline: () => void;
  /** Record the latest minted share link token (for later revocation). */
  setCollabLastShareToken: (token: string | null) => void;
  /** Take the pending geometry notice, clearing it (one delivery per message). */
  consumeCollabGeometryNotice: () => string | null;
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
  //
  //    EVERY action below takes the edited `modelId` as its first argument and
  //    gates itself on `roomStoreFor(get(), modelId)`, which returns the room's
  //    store only when that model IS the room's. The gate lives in the callee,
  //    never at the call site: a caller that resolves the room's store for an
  //    edit on another model writes a real path of the SHARED model — see
  //    `roomStoreFor`'s doc comment and `room-model-gate.test.ts`. Taking the
  //    `modelId` is what makes forgetting impossible; a new action that omits
  //    it is rejected by `scripts/check-collab-room-model-target.mjs`.
  mirrorPropertyEdit: (
    modelId: string,
    entityId: number,
    psetName: string,
    propName: string,
    value: unknown,
    valueType: PropertyValueType,
  ) => void;
  mirrorPropertyDelete: (
    modelId: string,
    entityId: number,
    psetName: string,
    propName: string,
  ) => void;
  mirrorAttributeEdit: (modelId: string, entityId: number, attrName: string, value: unknown) => void;
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
   *
   * Also the gizmo's "is this entity movable?" gate, via `readEntityPosition` —
   * so `modelId` is load-bearing twice over: without it the gizmo appears on a
   * PRIVATE model's entities (the room's dense `idToPath` resolves any id), and
   * dragging it runs the corruption.
   */
  readCollabPlacement: (modelId: string, entityId: number) => LocalPlacement | null;
  /**
   * Collab-native MOVE for a store with no STEP chain (recipient): composes
   * `deltaIfc` onto the entity's current placement, writes `usd::xformop`,
   * mirrors to peers, and moves the local mesh. Returns true when applied.
   */
  collabTranslateEntity: (
    modelId: string,
    entityId: number,
    deltaIfc: [number, number, number],
  ) => boolean;
  /**
   * Collab-native ROTATE (yaw about Z) for a store with no STEP chain. Composes
   * the yaw onto `usd::xformop`, mirrors to peers, and live-rotates the local
   * mesh about its bbox centre. Returns true when applied.
   */
  collabRotateEntity: (modelId: string, entityId: number, deltaYaw: number) => boolean;
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
// federation GLOBAL id (`toGlobalIdFromModels`), because a room holds one
// model per slot (#4444) and two slots can share every local expressId. Lets
// inbound placement edits push only the *incremental* delta (and avoids
// re-applying our own edits).
let placementAppliedLoc: Map<number, [number, number, number]> | null = null;
// Companion to placementAppliedLoc: renderer-frame yaw (radians) currently
// baked into each entity's live mesh, relative to its baked baseline.
let placementAppliedYaw: Map<number, number> | null = null;

/** Normalize a builder's STEP-uppercase type ('IFCWALL') to IFC case ('IfcWall'). */
function normalizeIfcClass(stepType: string): string {
  if (!stepType.toUpperCase().startsWith('IFC')) return stepType;
  const rest = stepType.slice(3);
  return `Ifc${rest.charAt(0).toUpperCase()}${rest.slice(1).toLowerCase()}`;
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
 *
 * `entityId` is in `modelId`'s id space at every call site, and `modelId` is
 * one of the ROOM's models — every caller established that first, through
 * `roomStoreFor(get(), modelId)` outbound or `roomEntityTargetForPath` inbound
 * — so the mesh it addresses is `toGlobalIdFromModels(models, modelId, id)`
 * and the pivot comes out of THAT model's meshes (`roomMeshesFor`), never the
 * active model's.
 */

function reconcilePlacementMesh(
  get: () => ViewerState,
  modelId: string,
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
  // The ROOM model the edit names, not the active one. `entityId` is in that
  // model's id space, and `globalId` is `idOffset + expressId` of a NAMED
  // model: a recipient's room models sit in their own federation ranges while
  // the user's own file sits in another, so a recipient with their own file
  // active would move an unrelated mesh — or none — for an edit that was
  // delivered correctly. The applied bookkeeping is keyed by this global id.
  const globalId = toGlobalIdFromModels(get().models, modelId, entityId);

  // ── Translation ──
  const target = rendererDeltaForPlacement(baseline, placement);
  const applied = placementAppliedLoc.get(globalId) ?? [0, 0, 0];
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
    placementAppliedLoc.set(globalId, target);
  }

  // ── Rotation (yaw about Z = renderer rotation about +Y, same angle) ──
  // Pivot is the entity's bbox centre in renderer world — identical on every
  // client (same geometry), so the live rotation stays consistent across peers.
  const targetYaw = yawOf(placement) - yawOf(baseline);
  const appliedYaw = placementAppliedYaw.get(globalId) ?? 0;
  const incYaw = targetYaw - appliedYaw;
  if (Math.abs(incYaw) >= YAW_EPS) {
    // Same reason as `globalId` above: the pivot is this entity's bbox centre,
    // looked up by the room-model `globalId`, so it has to come out of THAT
    // room model's meshes.
    const meshes = roomMeshesFor(get(), modelId);
    const c = getEntityCenter(meshes, globalId);
    if (c) {
      get().setPendingMeshRotations(
        new Map([[globalId, { angle: incYaw, pivot: [c.x, c.y, c.z] as [number, number, number] }]]),
      );
      placementAppliedYaw.set(globalId, targetYaw);
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
  collabRoomModels: new Map(),
  collabDraftBaseline: null,
  collabPeersSinceBaseline: false,
  collabRole: null,
  collabIdentity: loadOrCreateIdentity(),
  collabPeers: [],
  collabConnecting: false,
  collabSelfToken: null,
  collabLastShareToken: null,
  collabPanelVisible: false,
  collabSeedFailure: null,
  collabSeedPhase: 'none',
  collabSeedProgress: null,
  collabGeometryNotice: null,

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
    // The models this room's edits belong to, resolved ONCE, before any await
    // inside this function: for an owner they are the models of the share
    // scope, each assigned the room slot of its position in the seed (#4444);
    // for a recipient they are the `room:<roomId>:<slotId>` models the
    // reconstruct registers — one per slot the room turns out to hold, so a
    // recipient's map is published from the reconstruct itself, once the room
    // has synced, and is EMPTY until then. Every later resolution reads this
    // via `@/lib/collab/room-model-target`, never `activeModelId`, which the
    // user can change with two clicks (`upsertModel` does not switch focus,
    // modelSlice.ts). An empty map on a live session fails every resolver
    // closed, which is the correct answer while the room's models are not
    // known or not registered.
    const roomModels = new Map<string, ModelSlotRef>();
    seed?.models.forEach((m, index) => roomModels.set(m.modelId, roomSlotRef(index)));
    set({
      collabConnecting: true,
      collabRoomId: roomId,
      collabRoomModels: roomModels,
      collabRole: role,
      collabSelfToken: token ?? null,
      // An owner's seed is in flight from this very moment, before the session
      // even exists: set in the SAME synchronous set() as `collabRoomId` so no
      // subscriber can observe a room with nothing pending and mint an invite.
      collabSeedPhase: seed ? 'syncing' : 'none',
      collabSeedProgress: null,
    });

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
    let collabMod: typeof import('@ifc-lite/collab');
    try {
      // Lazy-load the collab runtime (code-split) — see the import note above.
      const collab = await import('@ifc-lite/collab');
      collabMod = collab;
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
      // `collabRoomId` / `collabRole` / `collabSelfToken` were set synchronously
      // above, before any session existed, so a UI reading "collabRoomId is set"
      // as "still in the room" (the toolbar indicator, ShareDialog) — and
      // canCollabEdit()/canCollabComment(), which mutationSlice gates every
      // write on — must not keep applying a room/role that never actually
      // started. Guarded on collabRoomId still matching this attempt so a
      // newer start/stop that ran while we awaited isn't clobbered here.
      if (get().collabRoomId === roomId) {
        set({
          collabConnecting: false,
          collabStatus: 'disconnected',
          collabRoomId: null,
          collabRole: null,
          collabSelfToken: null,
          collabSeedPhase: 'none',
        });
      } else {
        set({ collabConnecting: false, collabStatus: 'disconnected' });
      }
      return;
    }

    // If a newer start/stop happened while we were awaiting, discard.
    if (get().collabRoomId !== roomId) {
      session.dispose();
      return;
    }

    const selfClientId = session.clientId;
    session.presence.onUpdate((peers) => {
      const remote = remotePeers(peers, selfClientId);
      set((state) => ({
        collabPeers: remote,
        collabPeersSinceBaseline: state.collabPeersSinceBaseline || remote.length > 0,
      }));
    });
    session.onStatus((status) => set({ collabStatus: status }));
    // Broadcast our role so peers can show it in the roster (advisory; the
    // authoritative role is the server-verified token).
    try {
      session.presence.patch({ role });
    } catch {
      /* cleanup — safe to ignore: presence may not accept the patch in older runtimes */
    }

    /**
     * This join's own recipient teardown, kept beside the module-level slot it
     * is published into. The abandoned-join guard below has to be able to run
     * the teardown THIS join installed and no other: the slot is module-level,
     * so by the time a stale continuation reaches that guard a newer join may
     * already own it. (#3016)
     */
    let ownLiveTeardown: (() => void) | null = null;

    const geomApi: CollabGeomApi = {
      createGeometry: (doc, geomId, opts) => collabMod.createGeometry(doc, geomId, opts),
      hasEntity: (doc, path) => collabMod.hasEntity(doc, path),
      addGeometryRef: (doc, path, geomId) => collabMod.addGeometryRef(doc, path, geomId),
      setGeometryRef: (doc, path, ref) => collabMod.setGeometryRef(doc, path, ref),
      getGeometryRef: (doc, path) => collabMod.getGeometryRef(doc, path),
      getGeometry: (doc, geomId) => collabMod.getGeometry(doc, geomId),
      iterEntities: (doc) => collabMod.iterEntities(doc),
    };
    // Doc reads for the reconstruct-side placement sweep (placement-sweep.ts).
    const sweepApi: PlacementSweepApi = {
      iterEntities: (doc) => collabMod.iterEntities(doc),
      getEntityPlacement: (doc, path) => collabMod.getEntityPlacement(doc, path),
      getPlacementBaseline: (doc, path) => collabMod.getPlacementBaseline(doc, path),
    };
    // Expose the geometry API + a blob-store factory so a local create can push
    // the new mesh blob into the room later (not just at seed).
    geomApiRef = geomApi;
    makeBlobStore = () => createSharedBlobStore(collabMod, collabServerUrl(), token);
    cachedBlobStore = null;

    // Owner seeds every model of the share scope into the Y.Doc (plan §4.6
    // seed-into-room), one slot each, once the room has synced — structure
    // only into slots the room does not hold yet, so we don't re-seed a
    // populated room or clobber a peer's edits (see owner-seed.ts for the two
    // per-slot guards). Recipients pass no `seed` and hydrate from the doc.
    // The seed's phases are mirrored into `collabSeedPhase` (#4446):
    // `collabStatus` says 'connected' long before the room holds the models,
    // and the Share dialog must key off THIS, not that. Every write is
    // guarded on the join still being current, so a Leave landing mid-seed
    // cannot have a stale continuation re-stamp it.
    if (seed) {
      const current = () => get().collabRoomId === roomId;
      // Loaded lazily so the collab feature stays code-split.
      const { parseIfcxViewerModel } = await import('@/hooks/ingest/viewerModelIngest');
      const outcome = await runOwnerSeed({
        session,
        seed,
        collab: collabMod,
        geomApi,
        makeBlobStore: () => createSharedBlobStore(collabMod, collabServerUrl(), token),
        parseIfcx: (buffer) => parseIfcxViewerModel(buffer, undefined, { allowEmptyGeometry: true }),
        roomModels,
        // Record the placement each entity's blob is baked at, so every
        // client (incl. late joiners) can render `blob + (current
        // usd::xformop − baseline)`. The blob is baked at whatever
        // placement the doc holds now: the seeded `usd::xformop` for IFCX
        // models, identity for legacy STEP (geometry baked world-absolute).
        stampBaseline: (path) => {
          if (path && placementApi) {
            const currentPlacement = placementApi.getEntityPlacement(session.doc, path);
            placementApi.setPlacementBaseline(session.doc, path, currentPlacement ?? { location: [0, 0, 0] });
          }
          return path;
        },
        isCurrent: current,
        onPhase: (phase) => {
          if (current()) set({ collabSeedPhase: phase });
        },
        onProgress: (progress) => {
          if (current()) set({ collabSeedProgress: progress });
        },
      });
      if (outcome && current()) {
        set({ collabSeedPhase: outcome.phase, collabSeedFailure: outcome.failure });
      }
    } else {
      // Recipient (deep-link join, no local model): reconstruct every model
      // the room holds from the CRDT as IFCX, one viewer model per slot — see
      // room-reconstruct.ts, which owns the whole derivation (snapshot per
      // slot, federation registration, blob hydration, placement sweep) and
      // the live re-reconstruct on peer edits.
      try {
        await session.whenSynced;
        // Loaded lazily so the collab feature stays code-split.
        const { parseIfcxViewerModel } = await import('@/hooks/ingest/viewerModelIngest');
        const blobStore = await createSharedBlobStore(collabMod, collabServerUrl(), token);
        const reconstructor = createRoomReconstructor({
          roomId,
          session,
          collab: collabMod,
          geomApi,
          sweepApi,
          blobStore,
          parseIfcx: (buffer) => parseIfcxViewerModel(buffer, undefined, { allowEmptyGeometry: true }),
          get,
          setRoomModels: (models) => {
            // The room's models are named here, from the doc, once the slots
            // are known — the recipient half of the "resolved once" contract
            // in the synchronous prefix above. Guarded like every other
            // post-await write in this function.
            if (get().collabRoomId === roomId) set({ collabRoomModels: models });
          },
          notify: (message) => {
            if (get().collabRoomId === roomId) set({ collabGeometryNotice: message });
          },
          applied: () => ({ loc: placementAppliedLoc, yaw: placementAppliedYaw }),
          reconcile: (modelId, store, entityId, placement) => {
            reconcilePlacementMesh(get, modelId, store, session.doc, entityId, placement);
          },
        });

        // Initial build (only when we don't already have a local model).
        if (get().collabRoomId === roomId && !get().ifcDataStore) {
          await reconstructor.reconstruct();
        }

        // Live updates: re-reconstruct (debounced) whenever a peer edits the doc.
        reconstructor.attachLive();
        ownLiveTeardown = reconstructor.teardown;
        // Published into the module-level slot only while this join is still
        // the live one. A join the user left mid-reconstruct resumes here after
        // whatever came next — including a NEWER join that has already put its
        // own teardown in the slot — and an unconditional assignment overwrote
        // it, so the newer room's model was never removed on the next Leave
        // while this dead one's was removed twice. The abandoned case is
        // handled by the guard below, which runs `ownLiveTeardown` directly
        // rather than through the slot. (#3016)
        //
        // Same granularity as every other re-check in this function: it cannot
        // tell a rejoin of the SAME room from this join still being live.
        if (get().collabRoomId === roomId) recipientLiveTeardown = ownLiveTeardown;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] model reconstruction failed:', err);
      }
    }

    // The seed/reconstruct branches above re-check `collabRoomId === roomId`
    // after each of their own awaits, but nothing after them did: a
    // `stopCollab()` landing anywhere in the awaits above (e.g. RoomPanel's
    // "Leave" button, reachable the moment `collabRoomId` is set — before
    // this join has finished) left `collabRoomId`/`collabSession` cleared,
    // and this function then sailed on regardless, wiring up
    // `remoteApplyTeardown` for a session nothing still tracks and ending
    // with a `set({ collabSession: session, ... })` that revived a session
    // the user had explicitly left. Same guard as every other
    // `collabRoomId`-vs-`roomId` re-check earlier in `startCollab`, added
    // for the one block that had none.
    if (get().collabRoomId !== roomId) {
      // Run the cleanup this join installed after its last guarded await, which
      // returning here would otherwise skip: the recipient branch registers the
      // `room:<roomId>` model, then assigns its teardown, then falls through to
      // this check. A Leave landing in that window left the model in `models`
      // (and the doc listener attached) until the next `stopCollab` — an orphan
      // sitting in the store between leaving and rejoining. (#3016)
      //
      // This join's OWN closure, never whatever the module-level slot holds:
      // by the time a stale continuation gets here, a newer join may already
      // have published its own teardown there, and running THAT one would drop
      // the room model of the session the user is actually in. The assignment
      // above is conditional for the same reason, so the slot cannot be
      // holding this closure here — nothing to clear.
      if (ownLiveTeardown) {
        try {
          ownLiveTeardown();
        } catch {
          /* cleanup — safe to ignore */
        }
      }
      session.dispose();
      return;
    }

    // Remote → local apply (plan §7.5): replay peers' property/attribute edits
    // into the ROOM model's MutablePropertyView (no undo tracking, no echo).
    //
    // Resolved per event BY PATH off `collabRoomModels` — the path's slot
    // names the model (#4444) — never off `activeModelId` and never captured
    // once. A peer's edit carries an expressId in ONE room model's id space,
    // so it is only meaningful against that model's own store and view.
    // Targeting the active model wrote it into the user's own file instead.
    // Not into `undoStacks` / `dirtyModels` — the handlers below call the view
    // directly, which is what "no undo tracking" above means — but into that
    // view's overlay and append-only `mutationHistory`, which the exporter and
    // `getModifiedEntityCount` read, so it survived a reload and shipped in
    // their exported IFC.
    // `roomEntityTargetForPath` returns null until the room model is
    // registered, and every handler drops the event rather than falling back
    // to another model; the next reconstruct rebuilds the whole model from
    // the CRDT anyway. Each handler is handed the model the resolver named
    // and re-gates on it (`roomStoreFor` / `roomMutationViewFor`), so a
    // handler cannot be handed one model and write another.
    remoteApplyTeardown = attachRemoteApply(docApi!, session, (path) => roomEntityTargetForPath(get(), path), {
      onProperty: (modelId, entityId, pset, prop, value, type) => {
        const view = roomMutationViewFor(get(), modelId);
        if (!view) return;
        view.setProperty(entityId, pset, prop, value, type);
        set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
      onPropertyDelete: (modelId, entityId, pset, prop) => {
        const view = roomMutationViewFor(get(), modelId);
        if (!view) return;
        view.deleteProperty(entityId, pset, prop);
        set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
      // A peer's whole Pset vanished (its last property was deleted, which
      // cascades). Property names are unavailable at this point (see the
      // handler's doc comment in mutation-bridge.ts), so drop the entire set
      // rather than trying to replay per-property deletes.
      onPsetDelete: (modelId, entityId, pset) => {
        const view = roomMutationViewFor(get(), modelId);
        if (!view) return;
        view.deletePropertySet(entityId, pset);
        set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
      onAttribute: (modelId, entityId, attrName, value) => {
        const view = roomMutationViewFor(get(), modelId);
        if (!view) return;
        view.setAttribute(entityId, attrName, value === null ? '' : String(value));
        set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
      // A peer moved/rotated an entity: reflect it on the local mesh by
      // pushing the incremental renderer-frame delta (no undo, no echo).
      onPlacement: (modelId, entityId, placement) => {
        const store = roomStoreFor(get(), modelId);
        if (!store) return;
        reconcilePlacementMesh(get, modelId, store, session.doc, entityId, placement);
        set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
      // A peer deleted an entity: hide its mesh (matches the owner's local
      // removeEntity, which hides rather than destroying GPU buffers).
      //
      // Unlike the four handlers above, this one does not go through
      // `roomMutationViewFor`'s own null check, so it needs its own: in the
      // named-but-unregistered window (recipient with `?room=&model=` before
      // the first reconstruct completes) `toGlobalIdFromModels` falls back to
      // the bare expressId for a model it can't find — which can collide with
      // an offset-0 model of the user's OWN. Gating on `roomStoreFor`
      // (non-null only once the model exists) makes this drop the event
      // exactly like its siblings until then.
      onEntityDelete: (modelId, entityId) => {
        if (!roomStoreFor(get(), modelId)) return;
        const globalId = toGlobalIdFromModels(get().models, modelId, entityId);
        get().hideEntities([globalId]);
        set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
    });

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
      // Fork point for session-draft publishing: the doc is synced (and
      // seeded, for owners) by the time the session is committed.
      collabDraftBaseline: session.captureDocState(),
      collabPeersSinceBaseline: get().collabPeers.length > 0,
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
      collabRoomModels: new Map(),
      collabDraftBaseline: null,
      collabPeersSinceBaseline: false,
      collabRole: null,
      collabPeers: [],
      collabConnecting: false,
      collabSelfToken: null,
      collabLastShareToken: null,
      collabPanelVisible: false,
      collabSeedFailure: null,
      collabSeedPhase: 'none',
      collabSeedProgress: null,
      collabGeometryNotice: null,
    });
  },

  resetCollabDraftBaseline: () => {
    const session = get().collabSession;
    if (session) {
      set({
        collabDraftBaseline: session.captureDocState(),
        collabPeersSinceBaseline: get().collabPeers.length > 0,
      });
    }
  },

  setCollabLastShareToken: (token) => set({ collabLastShareToken: token }),

  consumeCollabGeometryNotice: () => {
    const notice = get().collabGeometryNotice;
    if (notice) set({ collabGeometryNotice: null });
    return notice;
  },

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

  canCollabEdit: () => roleCanEdit(get().collabRole),

  canCollabComment: () => {
    const role = get().collabRole;
    if (role === null) return true;
    return role === 'commenter' || role === 'editor' || role === 'admin';
  },

  // `roomStoreFor` is the room gate and the store lookup in one call: it hands
  // back the ROOM's store, and only when `modelId` IS the room's model. Doing
  // the lookup without the gate is the dangerous half — the room's `idToPath`
  // is dense over its own ids, so a PRIVATE model's expressId resolves to a
  // real path of the SHARED model and the mirror writes it onto an unrelated
  // peer's entity. Gating in the callee (not at the call site) means a new
  // caller cannot forget.
  mirrorPropertyEdit: (modelId, entityId, psetName, propName, value, valueType) => {
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    if (!session || !store || !docApi) return;
    mirrorProperty(docApi, session, store, entityId, psetName, propName, value, valueType);
  },

  mirrorPropertyDelete: (modelId, entityId, psetName, propName) => {
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    if (!session || !store || !docApi) return;
    mirrorPropertyDelete(docApi, session, store, entityId, psetName, propName);
  },

  mirrorAttributeEdit: (modelId, entityId, attrName, value) => {
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    if (!session || !store || !docApi) return;
    mirrorAttribute(docApi, session, store, entityId, attrName, value);
  },

  mirrorPlacementEdit: (modelId, entityId, deltaIfc, deltaYaw = 0) => {
    // Only the ROOM's model syncs: an edit on any other loaded model is the
    // user's private work, and mirroring it broadcast their file into the
    // shared room, where the id resolved to some unrelated entity of the
    // owner's model. `roomStoreFor` is that gate and the store lookup in one
    // call — see its doc comment for why the lookup alone is the dangerous
    // half — and it is inside every modelId-taking action rather than at their
    // call sites, so a new call site cannot forget.
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
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
    // edit (and so a remote edit computes the correct incremental). Keyed by
    // global id like the reconciler (see `placementAppliedLoc`).
    const globalId = toGlobalIdFromModels(get().models, modelId, entityId);
    placementAppliedLoc.set(globalId, rendererDeltaForPlacement(baseline, next));
    if (placementAppliedYaw) placementAppliedYaw.set(globalId, yawOf(next) - yawOf(baseline));
  },

  readCollabPlacement: (modelId, entityId) => {
    const session = get().collabSession;
    // Room model only — see `mirrorPlacementEdit`. This is a read, but not a
    // harmless one: `readEntityPosition` uses it as the gizmo's "is this entity
    // movable?" gate, so an ungated version puts the move gizmo on a PRIVATE
    // model's entities (the room's dense `idToPath` resolves any id to some
    // real room path), and dragging it runs the write below.
    const store = roomStoreFor(get(), modelId);
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

  collabTranslateEntity: (modelId, entityId, deltaIfc) => {
    const session = get().collabSession;
    // Room model only — see `mirrorPlacementEdit`.
    const store = roomStoreFor(get(), modelId);
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
    reconcilePlacementMesh(get, modelId, store, session.doc, entityId, next);
    return true;
  },

  collabRotateEntity: (modelId, entityId, deltaYaw) => {
    const session = get().collabSession;
    // Room model only — see `mirrorPlacementEdit`.
    const store = roomStoreFor(get(), modelId);
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
    reconcilePlacementMesh(get, modelId, store, session.doc, entityId, next);
    return true;
  },

  mirrorEntityRemove: (modelId, entityId) => {
    // Room model only — see `mirrorPlacementEdit`.
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    if (!session || !store || !docApi) return;
    if (!get().canCollabEdit()) return;
    mirrorEntityDelete(docApi, session, store, entityId);
    // Drop any placement tracking for the removed entity.
    const globalId = toGlobalIdFromModels(get().models, modelId, entityId);
    placementAppliedLoc?.delete(globalId);
    placementAppliedYaw?.delete(globalId);
  },

  mirrorEntityCreate: (modelId, entityId, ifcType, guid, mesh) => {
    // Room model only — see `mirrorPlacementEdit`.
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    if (!session || !store || !docApi || !placementApi || !geomApiRef) return;
    if (!get().canCollabEdit()) return;
    // Overlay (runtime-created) entities aren't in the store's GUID maps, so
    // derive the path from the new entity's GlobalId — in the store's room
    // slot, like every seeded path — and register it so this (and later
    // edits to it) resolve.
    let path = pathForEntity(store, entityId);
    if (!path && guid) {
      path = pathForGuid(store, guid);
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
          const report = await seedGeometryToRoom(geom, session, cachedBlobStore, [mesh], () => path);
          if (report.seeded === 0) {
            // eslint-disable-next-line no-console
            console.error('[collab] mirror create geometry failed:', report);
            set({ collabGeometryNotice: 'The new element could not be shared with the room.' });
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[collab] mirror create geometry failed:', err);
          set({ collabGeometryNotice: 'The new element could not be shared with the room.' });
        }
      })();
    }
  },

  mirrorEntityGeometry: (modelId, entityId, mesh) => {
    // Room model only — see `mirrorPlacementEdit`.
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    if (!session || !store || !geomApiRef || !makeBlobStore) return;
    if (!get().canCollabEdit()) return;
    const path = pathForEntity(store, entityId);
    if (!path) return;
    // The new mesh is baked at the entity's current world position (identity
    // baseline, set at create/seed). Reset applied tracking so the fresh blob
    // is treated as the new zero (resize-after-move on a peer is an accepted v1
    // limitation — the peer's stale applied delta isn't reset remotely).
    const globalId = toGlobalIdFromModels(get().models, modelId, entityId);
    placementAppliedLoc?.delete(globalId);
    placementAppliedYaw?.delete(globalId);
    const geom = geomApiRef;
    void (async () => {
      try {
        cachedBlobStore = cachedBlobStore ?? (await makeBlobStore!());
        const report = await seedGeometryToRoom(geom, session, cachedBlobStore, [mesh], () => path, {
          replace: true,
        });
        if (report.seeded === 0) {
          // eslint-disable-next-line no-console
          console.error('[collab] mirror resize geometry failed:', report);
          set({ collabGeometryNotice: 'The updated geometry could not be shared with the room.' });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] mirror resize geometry failed:', err);
        set({ collabGeometryNotice: 'The updated geometry could not be shared with the room.' });
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
