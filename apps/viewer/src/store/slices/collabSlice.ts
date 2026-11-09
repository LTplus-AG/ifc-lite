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
 */

import type { StateCreator } from 'zustand';
import { bindRoomPropertyApi } from '@/lib/collab/room-property-api';
import { attachRoomSpatialContextMirror } from '@/lib/collab/room-spatial-context-mirror';
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
  applyIdentityPatch,
  loadOrCreateIdentity,
  persistIdentity,
  type EphemeralIdentity,
} from '@/lib/collab/identity';
import {
  attachRemoteApply, applyRemoteAttribute,
  mirrorAttribute,
  mirrorEntityDelete,
  mirrorPlacement,
  mirrorProperty,
  mirrorPropertyDelete,
} from '@/lib/collab/mutation-bridge';
import { pathForEntity, pathForGuid, registerEntityPath } from '@/lib/collab/entity-paths';
import { createRemoteOverlayEntity, deleteRemoteOverlayEntity } from '@/lib/collab/remote-entity-create';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { seedGeometryToRoom } from '@/lib/collab/geometry-sync';
import { runOwnerSeed, type CollabSeedInput } from '@/lib/collab/owner-seed';
import { buildOwnerSeedDeps } from '@/lib/collab/owner-seed-deps';
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
  beginCollabAttempt,
  collabAttemptApis,
  liveCollabAttempt,
  type CollabAttempt,
  type CollabAttemptApis,
} from '@/lib/collab/session-attempt';
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
 * form. The shared mutation permission selector calls that store-bound form,
 * so Bulk, CSV, Properties, and script authoring share the same role rule.
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
    dataType?: string,
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
    mesh: MeshData | null, initialAttributes?: Record<string, unknown>, sourceExpressId?: number,
  ) => void;
  /**
   * Mirror a geometry change by replacing the entity's room geometry with its
   * freshly-tessellated meshes (a re-meshed element can have several, one per
   * material layer, #6232), baked at the entity's current world position so
   * they carry the new shape + placement. Resets the entity's placement
   * baseline to identity for the new blob. No-op without a session, edit
   * rights or meshes.
   */
  mirrorEntityGeometry: (modelId: string, entityId: number, meshes: readonly MeshData[]) => void;
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
  attempt: CollabAttempt,
  get: () => ViewerState,
  modelId: string,
  store: IfcDataStore,
  doc: CollabSession['doc'],
  entityId: number,
  placement: LocalPlacement,
): void {
  const placementApi = attempt.apis?.placement;
  if (!placementApi) return;
  const { placementAppliedLoc, placementAppliedYaw } = attempt;
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
export const createCollabSlice: StateCreator<ViewerState, [], [], CollabSlice> = (set, get, api) => ({
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
    const next = applyIdentityPatch(get().collabIdentity, patch);
    if (!next) return;
    persistIdentity(next);
    set({ collabIdentity: next });
    const session = get().collabSession;
    if (session) {
      const user: UserIdentity = { id: next.id, name: next.name, color: next.color };
      session.presence.setUser(user);
    }
  },

  startCollab: async ({ roomId, role, token, seed }) => {
    // Tear down any existing session first (idempotent join), then open this
    // join's attempt. `attempt.live` — never `collabRoomId === roomId`, which a
    // Leave + rejoin of the SAME room satisfies for the abandoned join too — is
    // the only currency check below; see session-attempt.ts.
    get().stopCollab();
    const attempt = beginCollabAttempt(roomId);
    const current = () => attempt.live;
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
    let apis: CollabAttemptApis;
    try {
      // Lazy-load the collab runtime (code-split) — see the import note above.
      const collab = bindRoomPropertyApi(await import('@ifc-lite/collab'));
      collabMod = collab;
      apis = collabAttemptApis(collab);
      attempt.apis = apis;
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
      // started. Only while this attempt is still live: a stale attempt that
      // fails after a Leave + rejoin of the same room must not clear the
      // rejoin's room fields (or its connecting flag) — they are not its own.
      if (current()) {
        attempt.retire();
        set({
          collabConnecting: false,
          collabStatus: 'disconnected',
          collabRoomId: null,
          collabRole: null,
          collabSelfToken: null,
          collabSeedPhase: 'none',
        });
      }
      return;
    }

    // A retired attempt (Leave, or a newer join) disposes the session it just
    // created and stops here.
    if (!attempt.adopt(session)) return;

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

    const geomApi = apis.geom;
    // Doc reads for the reconstruct-side placement sweep (placement-sweep.ts).
    const sweepApi: PlacementSweepApi = {
      iterEntities: (doc) => collabMod.iterEntities(doc),
      getEntityPlacement: (doc, path) => collabMod.getEntityPlacement(doc, path),
      getPlacementBaseline: (doc, path) => collabMod.getPlacementBaseline(doc, path),
    };
    // A blob-store factory so a local create can push the new mesh blob into
    // the room later (not just at seed).
    attempt.setBlobStoreFactory(() => createSharedBlobStore(collabMod, collabServerUrl(), token));

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
      // Loaded lazily so the collab feature stays code-split.
      const { parseIfcxViewerModel } = await import('@/hooks/ingest/viewerModelIngest');
      const outcome = await runOwnerSeed(
        buildOwnerSeedDeps({
          session,
          seed,
          collab: collabMod,
          geomApi,
          serverUrl: collabServerUrl(),
          roomId,
          token,
          roomModels,
          parseIfcx: (buffer) => parseIfcxViewerModel(buffer, undefined, { allowEmptyGeometry: true }),
          isCurrent: current,
          onPhase: (phase) => {
            if (current()) set({ collabSeedPhase: phase });
          },
          onProgress: (progress) => {
            if (current()) set({ collabSeedProgress: progress });
          },
        }),
      );
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
            if (current()) set({ collabRoomModels: models });
          },
          notify: (message) => {
            if (current()) set({ collabGeometryNotice: message });
          },
          applied: () => ({ loc: attempt.placementAppliedLoc, yaw: attempt.placementAppliedYaw }),
          reconcile: (modelId, store, entityId, placement) => {
            reconcilePlacementMesh(attempt, get, modelId, store, session.doc, entityId, placement);
          },
        });

        // Initial build (only when we don't already have a local model).
        if (current() && !get().ifcDataStore) {
          await reconstructor.reconstruct();
        }

        // Live updates: re-reconstruct (debounced) whenever a peer edits the doc.
        // The teardown belongs to THIS attempt: a join the user left
        // mid-reconstruct runs it on the spot (its attempt already retired),
        // so its room models never linger and never touch a newer join's (#3016).
        reconstructor.attachLive();
        attempt.onRetire(reconstructor.teardown);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] model reconstruction failed:', err);
      }
    }

    // A Leave (or a newer join) landing in any await above retired this
    // attempt: its session is already disposed and everything it registered
    // has been or will be torn down by `onRetire`. Nothing below may wire up a
    // session nothing tracks, or revive one the user explicitly left.
    if (!current()) return;
    // Replay peer edits into the named ROOM model without local undo or echo.
    // Room paths, never activeModelId, select the model because expressIds are
    // model-local. Resolution fails closed until registration; reconstruct then
    // rebuilds from the CRDT.
    const rejectRemoteWrite = (rejected: string) => {
      console.warn('[collab] rejected remote write:', rejected);
      set({ collabGeometryNotice: `A collaborative edit could not be applied: ${rejected}` });
    };
    const detachRemoteApply = attachRemoteApply(apis.doc, session, (path) => roomEntityTargetForPath(get(), path), {
      // Consulted by the bridge's single tombstone guard before any write (#5187).
      isLocallyDeleted: (modelId, entityId) => roomMutationViewFor(get(), modelId)?.isDeleted(entityId) ?? false,
      onRejectedWrite: rejectRemoteWrite,
      onEntityCreate: ({ modelId, store }, entityPath, ifcClass, attributes, sourceExpressId) => {
        const view = roomMutationViewFor(get(), modelId);
        if (view && createRemoteOverlayEntity(store, view, entityPath, ifcClass, attributes,
          rejectRemoteWrite, sourceExpressId))
          set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
      onProperty: (modelId, entityId, pset, prop, value, type, dataType) => {
        const view = roomMutationViewFor(get(), modelId);
        if (!view) return;
        view.setProperty(entityId, pset, prop, value, type, undefined, false, dataType);
        get().invalidateHistoryForEntity(modelId, entityId); // clear stale history for this entity (#5223)
        set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
      onPropertyDelete: (modelId, entityId, pset, prop) => {
        const view = roomMutationViewFor(get(), modelId);
        if (!view) return;
        view.deleteProperty(entityId, pset, prop);
        get().invalidateHistoryForEntity(modelId, entityId); // #5223, see onProperty
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
        get().invalidateHistoryForEntity(modelId, entityId); // #5223, see onProperty
        set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
      onAttribute: (modelId, entityId, attrName, value) => {
        const view = roomMutationViewFor(get(), modelId), store = roomStoreFor(get(), modelId);
        if (!view || !store) return;
        const rejected = applyRemoteAttribute(view, store, entityId, attrName, value); // #4931
        if (rejected) return rejectRemoteWrite(rejected);
        get().invalidateHistoryForEntity(modelId, entityId); // covers UPDATE_ATTRIBUTE/POSITIONAL history (#5223)
        set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
      // A peer moved/rotated an entity: reflect it on the local mesh by
      // pushing the incremental renderer-frame delta (no undo, no echo).
      onPlacement: (modelId, entityId, placement) => {
        const store = roomStoreFor(get(), modelId);
        if (!store) return;
        reconcilePlacementMesh(attempt, get, modelId, store, session.doc, entityId, placement);
        get().invalidateHistoryForEntity(modelId, entityId); // clear stale placement history (#5223)
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
        const store = roomStoreFor(get(), modelId);
        if (!store) return;
        if (!deleteRemoteOverlayEntity(store, roomMutationViewFor(get(), modelId), entityId)) return;
        const globalId = toGlobalIdFromModels(get().models, modelId, entityId);
        get().hideEntities([globalId]);
        get().invalidateHistoryForEntity(modelId, entityId); // no local history may write onto this tombstone (#5223)
        set((s) => ({ mutationVersion: s.mutationVersion + 1 }));
      },
    });

    const detachSpatial = attachRoomSpatialContextMirror(api, session);
    attempt.onRetire(() => { detachRemoteApply(); detachSpatial(); });

    // Annotation (markup) sync: reflect peers' pins into the local slice, and
    // seed our existing local pins into the room ("share existing + new").
    try {
      attempt.onRetire(attachAnnotationInbound(session, apis.annotation, {
        myId: () => get().collabIdentity.id,
        getLocal: () => get().annotations,
        upsertRemote: (a) => get().upsertRemoteAnnotation(a),
        removeRemote: (id) => get().removeRemoteAnnotation(id),
      }));
      if (get().canCollabComment()) {
        for (const a of get().annotations.values()) {
          if (!a.remote) get().mirrorAnnotationUpsert(a);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab] annotation sync setup failed:', err);
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
    // Retiring the live attempt runs every teardown it registered and disposes
    // its session. A session committed without one (tests seed `collabSession`
    // directly) is still disposed here.
    const attempt = liveCollabAttempt();
    const committed = get().collabSession;
    attempt?.retire();
    if (committed && committed !== attempt?.session) {
      try {
        committed.dispose();
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
  mirrorPropertyEdit: (modelId, entityId, psetName, propName, value, valueType, dataType) => {
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    const docApi = liveCollabAttempt()?.apis?.doc;
    if (!session || !store || !docApi) return;
    mirrorProperty(docApi, session, store, entityId, psetName, propName, value, valueType, dataType);
  },

  mirrorPropertyDelete: (modelId, entityId, psetName, propName) => {
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    const docApi = liveCollabAttempt()?.apis?.doc;
    if (!session || !store || !docApi) return;
    mirrorPropertyDelete(docApi, session, store, entityId, psetName, propName);
  },

  mirrorAttributeEdit: (modelId, entityId, attrName, value) => {
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    const docApi = liveCollabAttempt()?.apis?.doc;
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
    const attempt = liveCollabAttempt();
    const apis = attempt?.apis;
    if (!session || !store || !attempt || !apis) return;
    const { doc: docApi, placement: placementApi } = apis;
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
    attempt.placementAppliedLoc.set(globalId, rendererDeltaForPlacement(baseline, next));
    attempt.placementAppliedYaw.set(globalId, yawOf(next) - yawOf(baseline));
  },

  readCollabPlacement: (modelId, entityId) => {
    const session = get().collabSession;
    // Room model only — see `mirrorPlacementEdit`. This is a read, but not a
    // harmless one: `readEntityPosition` uses it as the gizmo's "is this entity
    // movable?" gate, so an ungated version puts the move gizmo on a PRIVATE
    // model's entities (the room's dense `idToPath` resolves any id to some
    // real room path), and dragging it runs the write below.
    const store = roomStoreFor(get(), modelId);
    const apis = liveCollabAttempt()?.apis;
    if (!session || !store || !apis) return null;
    const { doc: docApi, placement: placementApi } = apis;
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
    const attempt = liveCollabAttempt();
    const apis = attempt?.apis;
    if (!session || !store || !attempt || !apis) return false;
    const { doc: docApi, placement: placementApi } = apis;
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
    reconcilePlacementMesh(attempt, get, modelId, store, session.doc, entityId, next);
    return true;
  },

  collabRotateEntity: (modelId, entityId, deltaYaw) => {
    const session = get().collabSession;
    // Room model only — see `mirrorPlacementEdit`.
    const store = roomStoreFor(get(), modelId);
    const attempt = liveCollabAttempt();
    const apis = attempt?.apis;
    if (!session || !store || !attempt || !apis) return false;
    const { doc: docApi, placement: placementApi } = apis;
    if (!get().canCollabEdit()) return false;
    const path = pathForEntity(store, entityId);
    if (!path) return false;
    const prev =
      placementApi.getEntityPlacement(session.doc, path) ??
      placementApi.getPlacementBaseline(session.doc, path) ?? { location: [0, 0, 0] };
    const next = composePlacement(prev, [0, 0, 0], deltaYaw);
    mirrorPlacement(docApi, session, store, entityId, next);
    // Live-rotate our own mesh via the shared reconciler (rotation branch).
    reconcilePlacementMesh(attempt, get, modelId, store, session.doc, entityId, next);
    return true;
  },

  mirrorEntityRemove: (modelId, entityId) => {
    // Room model only — see `mirrorPlacementEdit`.
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    const attempt = liveCollabAttempt();
    const docApi = attempt?.apis?.doc;
    if (!session || !store || !attempt || !docApi) return;
    if (!get().canCollabEdit()) return;
    mirrorEntityDelete(docApi, session, store, entityId);
    // Drop any placement tracking for the removed entity.
    const globalId = toGlobalIdFromModels(get().models, modelId, entityId);
    attempt.placementAppliedLoc.delete(globalId);
    attempt.placementAppliedYaw.delete(globalId);
  },
  mirrorEntityCreate: (modelId, entityId, ifcType, guid, mesh, initialAttributes, sourceExpressId) => {
    // Room model only — see `mirrorPlacementEdit`.
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    const attempt = liveCollabAttempt();
    const apis = attempt?.apis;
    if (!session || !store || !attempt || !apis) return;
    if (!get().canCollabEdit()) return;
    // Overlay entities aren't in the GUID maps; derive their room path and
    // register it only after CRDT creation succeeds so failed writes can retry.
    let path = pathForEntity(store, entityId);
    let generatedPath = false;
    if (!path && guid) {
      path = pathForGuid(store, guid);
      generatedPath = true;
    }
    if (!path) return;
    const ifcClass = normalizeIfcClass(ifcType);
    const api = apis.doc;
    session.transact(() => {
      api.createEntity(session.doc, path, {
        ifcClass,
        attributes: { 'bsi::ifc::class': { code: ifcClass }, ...initialAttributes },
        ...(sourceExpressId === undefined ? {} : { meta: { 'ifc-lite::sourceExpressId': sourceExpressId } }),
      });
    });
    if (generatedPath) registerEntityPath(store, entityId, path);
    // The mesh blob is baked at the element's world position → identity baseline
    // (so a later move composes correctly; see reconcilePlacementMesh).
    apis.placement.setPlacementBaseline(session.doc, path, { location: [0, 0, 0] });
    // Push the new mesh as a room blob so peers hydrate + render it. Async,
    // fire-and-forget — the local element already rendered.
    if (mesh && attempt.hasBlobStore()) {
      const geom = apis.geom;
      void (async () => {
        try {
          const blobStore = await attempt.blobStore();
          const report = await seedGeometryToRoom(geom, session, blobStore, [mesh], () => path);
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

  mirrorEntityGeometry: (modelId, entityId, meshes) => {
    // Room model only — see `mirrorPlacementEdit`.
    const session = get().collabSession;
    const store = roomStoreFor(get(), modelId);
    const attempt = liveCollabAttempt();
    const geom = attempt?.apis?.geom;
    if (!session || !store || !attempt || !geom || !attempt.hasBlobStore() || meshes.length === 0) return;
    if (!get().canCollabEdit()) return;
    const path = pathForEntity(store, entityId);
    if (!path) return;
    // The new mesh is baked at the entity's current world position (identity
    // baseline, set at create/seed). Reset applied tracking so the fresh blob
    // is treated as the new zero (resize-after-move on a peer is an accepted v1
    // limitation — the peer's stale applied delta isn't reset remotely).
    const globalId = toGlobalIdFromModels(get().models, modelId, entityId);
    attempt.placementAppliedLoc.delete(globalId);
    attempt.placementAppliedYaw.delete(globalId);
    void (async () => {
      try {
        const blobStore = await attempt.blobStore();
        const report = await seedGeometryToRoom(geom, session, blobStore, meshes, () => path, {
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
    const api = liveCollabAttempt()?.apis?.annotation;
    if (!session || !api || !get().canCollabComment()) return;
    session.transact(() => api.createAnnotation(session.doc, annotation.id, annotationToCrdtFields(annotation)));
  },

  mirrorAnnotationDelete: (id) => {
    const session = get().collabSession;
    const api = liveCollabAttempt()?.apis?.annotation;
    if (!session || !api || !get().canCollabComment()) return;
    session.transact(() => api.deleteAnnotation(session.doc, id));
  },
});
