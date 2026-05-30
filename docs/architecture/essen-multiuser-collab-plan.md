# Multiuser Collaboration in the Essen Web Viewer — Implementation Plan

**Status:** Draft v0.1 (planning only — no feature code yet).
**Branch:** `claude/essen-multiuser-collab-plan-uiSiJ`.
**Owner:** Louis Trümpler (LT+).
**Scope:** Wire the existing `@ifc-lite/collab` + `@ifc-lite/collab-server`
packages into `apps/viewer` so multiple people can open the same model and
see each other, comment, and edit — with **link-based sharing (no accounts)**
and **full support for legacy STEP IFC**, not just IFCX.

This document is the source of truth for the viewer-side rollout. It is the
*consumer* counterpart to `docs/architecture/collab-plan.md`, which tracks the
`@ifc-lite/collab` package itself. Where that doc ends ("…remains a
viewer-package task"), this one begins.

**Status legend:** ☐ pending · ◐ in progress · ☑ done · ⚠ blocked.

---

## 0. TL;DR

- We are **not building a collaboration engine** — it already exists and is
  production-grade. We are building the *viewer integration* and a *thin
  share/identity layer*.
- **Sharing is link-based and accountless.** A "Share" button mints a signed,
  short-lived **room token** that carries the role (`viewer` / `commenter` /
  `editor`). Anyone with the link joins; identity is ephemeral (pick a
  name + auto color, like a Figma guest / Google Docs anonymous animal).
- **Legacy STEP `.ifc` is fully supported** by keying the CRDT on the IFC
  **GlobalId (GUID)** instead of an IFCX path, and by reusing the existing
  `bindMutationsToCollab` bridge. IFCX (IFC5) remains the long-term native
  format; STEP is adapted, not privileged.
- Rollout is staged so each milestone is independently shippable behind a
  `collab.enabled` flag: **M1 presence + comments → M2 property editing →
  M3 geometry editing → M4 hardening/scale.**

---

## 1. What already exists (inventory — reuse, don't rebuild)

A deliberate audit of the two packages. The takeaway: the hard parts are done.

### 1.1 `@ifc-lite/collab` (client runtime) — v0.2.1

| Capability | Where | Notes |
|---|---|---|
| Session façade | `packages/collab/src/session.ts` | `createCollabSession({ roomId, user, provider, serverUrl, token })`. Glues Y.Doc + providers + presence + undo + conflicts. |
| Providers | `providers/{websocket,indexeddb,webrtc}.ts` | `'indexeddb+websocket'` recommended for browser. Token forwarded as `?token=`. |
| Presence / awareness | `awareness/{presence,overlay,render,color}.ts` | Typed `PresenceState`, stable per-user color hash, 30 Hz cap, 10 s stale eviction, cursor reprojection per camera. |
| **Viewer bridge** | `viewer-bridge.ts` | `mountPresenceInViewer({ session, container, viewport, raycastToWorld })` — drop-in, already designed for our viewport DOM. |
| Mutations bridge | `mutations/bind.ts` | `bindMutationsToCollab(view, session, { resolveEntity })` — mirrors `@ifc-lite/mutations` property writes into the CRDT. **This is our legacy-IFC seam.** |
| IFCX seed/snapshot | `snapshot/{from-ifcx,to-ifcx,layers}.ts` | `seedFromIfcx(doc, buf)`, `snapshotToIfcx(doc)`, per-user layer extraction. |
| Conflict detection | `conflicts/{detector,ui-bridge}.ts` | Emits structured events (ghost overlay, keep-mine/keep-theirs) for the viewer to render. |
| Undo | `undo.ts` | Local-origin `Y.UndoManager` — isolates each user's undo stack. |
| Federation | `federation/*` | Multi-model rooms (1 project = N models), cross-model records. |
| Geometry CRDT | `geometry/*` | Content-addressed blob store, parametric params, CSG, GC. |

### 1.2 `@ifc-lite/collab-server` (reference sync server) — v0.2.0

| Capability | Where | Notes |
|---|---|---|
| `y-websocket`-compatible server | `src/server.ts`, `bin.ts` | `startCollabServer({ port, persistence, authenticate, … })`. |
| **Roles + auth hook** | `src/auth.ts` | `Role = 'viewer' \| 'commenter' \| 'editor' \| 'admin'`, pluggable `AuthenticateFn(token, roomId) → Principal`, `canWrite(principal)`. **Exactly the access-rights model the product wants.** |
| Server-side write enforcement | `src/room-manager.ts` | `applyUpdateOrDeny` drops mutations from non-writers; per-message verifier hook. |
| Path locks | `src/path-locks.ts` | Per-section server-side locks (type promotion, etc.). |
| Audit log | `src/audit-log.ts` | Every connect/update/awareness event, JSONL sink. |
| Rate limiting | `src/rate-limit.ts` | Per-principal budgets (tighter for service accounts/agents). |
| Anti-replay | `src/replay-protect.ts` | Per-update nonce verification. |
| Persistence | `src/persistence{,-redis,-s3}.ts` | File (dev), Redis, S3 (prod). Compaction every N updates. |
| Blob route | `src/blob-route.ts` | Geometry blob upload/download with size limits. |
| Server snapshots | `src/snapshot-worker.ts` | Periodic `.ifcx` export per room. |

**Conclusion:** the *only* genuinely new code is (a) a small **token-minting
service** for accountless share links, (b) the **viewer UI + store wiring**,
and (c) the **STEP-IFC → CRDT adapter**.

### 1.3 The gap in the viewer (`apps/viewer`)

- No dependency on `@ifc-lite/collab` yet. No presence, no rooms, no sharing.
- **No authentication or user identity** anywhere (only BYOK API keys for the
  AI chat). `apps/server` is a stateless Rust parser; there is no app backend.
- State is **Zustand** with ~20 slices (`apps/viewer/src/store/`). Editing
  already works via `@ifc-lite/mutations` (`store/slices/mutationSlice.ts`).
- Models are loaded locally (file picker / drop / `?model=<url>` /
  IndexedDB recent-files) and identified by a **transient UUID**
  (`FederatedModel.id`) — there is no stable, shareable document id today.
- BCF comments already exist (`BCFPanel.tsx`, `bcfSlice.ts`) but are
  offline/manual import-export, with a free-text `bcfAuthor` string.

---

## 2. Product shape

### 2.1 The Share button

Lives in `MainToolbar.tsx`, grouped with the Download/Export controls. Clicking
it opens a dialog (Radix `Dialog`, already used throughout):

```
┌─ Share "Office-Tower-ARCH.ifc" ───────────────────┐
│                                                    │
│  Anyone with the link can:                         │
│     ( ) View      — see model, cursors, comments   │
│     ( ) Comment   — + add BCF issues/markups       │
│     (•) Edit      — + change properties & geometry │
│                                                    │
│  https://essen.ifclite.dev/m/AB12CD?t=eyJhbGciOi…  │
│                                          [ Copy ]  │
│                                                    │
│  Live now:  ●Louis (you)  ●anonymous-otter         │
│  Link expires in 7 days · [Revoke all links]       │
└────────────────────────────────────────────────────┘
```

- Three role choices map **directly** onto the server's `Role` enum
  (`viewer`/`commenter`/`editor`). `admin` is reserved for the room creator.
- The selected role is **baked into the token**, so a single dialog produces
  per-role links (or one link per role — see §3).
- "Live now" is just `session.presence` — free once presence is wired.

### 2.2 Identity — accountless, "modern"

No login, no email collection. On first join the user is assigned an
**ephemeral identity**:

- A friendly handle (`anonymous-otter`) editable inline, persisted in
  `localStorage` so the same browser keeps its name/color across sessions.
- A stable color via the existing `awareness/color.ts` hash.
- The room creator ("owner") is the browser that first opened/shared the
  model; ownership is held in a signed **owner token** in `localStorage`
  (and optionally re-mintable from the original file). No server-side user
  table.

This is the Figma-guest / Excalidraw model: zero friction, identity is a
display concern, and **authorization rides entirely in the room token**, not
in an account.

> **Upgrade path (out of scope for M1–M4, noted for completeness):** if named
> accounts are ever wanted, the `AuthenticateFn` already accepts any token —
> swap the link-token verifier for an OIDC/JWT verifier and add an invite-by-
> email UI. Nothing in M1–M4 blocks this.

---

## 3. Access model — link tokens (no accounts)

This is the only new *backend* concept. We need a tiny stateless endpoint (or
edge function) that signs and verifies room tokens. It can live in `apps/api`
(already exists for the chat proxy) or as a route on the collab-server itself.

### 3.1 Token

A short JWT (HS256, server-held secret), forwarded by the client as
`?token=` and validated by the collab-server's `AuthenticateFn`:

```jsonc
{
  "room": "m/AB12CD",        // room id (see §4.1)
  "role": "editor",          // viewer | commenter | editor (never admin via link)
  "kid": "v1",               // key id for rotation
  "jti": "…",                // unique id → enables revocation
  "iat": 1730000000,
  "exp": 1730604800          // default 7d, configurable in the Share dialog
}
```

- **Minting** (`POST /collab/token`): owner presents the **owner token** for a
  room + desired role + TTL → server returns a signed room token. Only the
  owner can mint.
- **Verifying** (`AuthenticateFn` in collab-server): decode, check signature +
  `exp`, check `jti` not in a revocation set, return
  `{ userId: <ephemeral id>, role }`. Re-validated every 5 min per spec (the
  server already does periodic re-auth).
- **Revocation**: "Revoke all links" rotates the room's `kid`; a tiny
  deny-list (`jti`) covers single-link revoke. Stored wherever the
  collab-server persistence lives (Redis/S3) — no user DB.

### 3.2 Why this satisfies "access rights like view / comment / edit"

The enforcement already exists server-side:

- `viewer` → read-only; `canWrite` returns false → mutations dropped by
  `applyUpdateOrDeny`. Presence still flows.
- `commenter` → may write **only** to the comment/BCF sub-tree; enforced with
  a `verifyMessage` hook + a `path-locks` rule scoping writes to the
  `comments` map (see §6).
- `editor` → full `canWrite`.

So the role chosen in the Share dialog is **enforced on the server**, not just
hidden in the UI — the important property for real access control.

---

## 4. Legacy STEP IFC adaptation (the hard part)

The CRDT data model (`packages/collab/src/doc/schema.ts`) is **IFCX-shaped**:
three top-level `Y.Map`s (`entities`, `relationships`, `geometry`) keyed by
**path strings**. IFCX files seed straight in via `seedFromIfcx`. STEP `.ifc`
files do **not** have IFCX paths — they have integer express IDs (`#123`) that
are *file-local and unstable across re-exports*. We need a stable key.

### 4.1 Stable identity: GUID-as-path

Every meaningful STEP entity (`IfcRoot` subtypes — walls, spaces, storeys,
rels) carries an **`IfcGloballyUniqueId` (GUID)** — a stable, file-independent
22-char identifier. The parser already extracts it (`@ifc-lite/parser` GUID
handling). We use the GUID as the CRDT key:

```
STEP express id  #145  ──┐
                         ├──►  GUID  "3vB2… Qd"  ──►  CRDT path  "/3vB2…Qd"
parser IfcDataStore  ────┘                            (key in entities Y.Map)
```

- **Room id** = `m/<random>` — an opaque id the **owner mints on Share**
  (explicit "start a shared session"), stored in the owner's `localStorage` as
  a model→room mapping so re-opening offers "resume sharing". *Not* derived
  from model content, so two revisions of a file don't silently collide. (The
  GUID-as-path keying below is independent of room-id choice.)
- Entities **without** a GUID (geometry primitives, placements, profiles) are
  *not* first-class CRDT entities; they live inside their owner entity's
  geometry record (already how `GeometryRef` works) and are addressed by a
  deterministic sub-key. This matches the IFCX model where only "objects" are
  path-addressable.

### 4.2 Seeding a STEP model into the Y.Doc

Two options; we plan **both**, sequenced:

1. **M2 (properties): seed lazily via the mutation bridge.** Do *not* convert
   the whole model. The model is loaded locally by every peer (they already
   have the bytes — same file behind the share link). The Y.Doc starts
   *empty* and accumulates only the **edit layer**: properties/relationships
   that someone actually changes, keyed by GUID. This is exactly what
   `extractUserLayer` / `to-ifcx` layering is built for, and it keeps the CRDT
   tiny (kilobytes, not the whole model). `resolveEntity(expressId)` →
   `guidPath` is the only new mapping (a `Map<number,string>` built once from
   the parsed store).

2. **Full seed / authoritative room: STEP → CRDT seeder.** For "send a link,
   anyone joins without the file" (the chosen transport — §4.6 option 3), add
   `seedFromStep(doc, ifcDataStore)` in `packages/collab` that walks the
   parsed `IfcDataStore` and emits `createEntity`/`setAttribute`/
   `createRelationship` calls keyed by GUID. This is the new
   `from-step.ts` counterpart to `from-ifcx.ts`. Snapshotting back out reuses
   `to-ifcx.ts` (CRDT → IFCX); a **CRDT → STEP** writer is a later concern
   (export already round-trips changes via `ExportChangesButton`).

> **Design call (decided):** ship approach (2) — **full seed** — from M1,
> because the chosen recipient transport is *seed-into-room* (§4.6 option 3):
> the model arrives through the Y.Doc, so the whole model must live in the
> CRDT. This pulls the `seedFromStep` work forward into M1 (it was M2.5) and
> trades a larger Y.Doc + more up-front seeder work for the cleanest "just
> send a link" UX. Approach (1) edit-layer-only remains the fallback if the
> recipient already has the file locally (then we seed only diffs).
>
> **Two consequences to design for (see open questions §10):**
> 1. **Y.Doc size / perf.** A 100k-entity model fully in the Y.Doc is far
>    bigger than an edit-layer. The `indexeddb+websocket` provider + server
>    compaction (every 1000 updates) are built for this, but we must measure
>    cold-join time against the §15 perf budget and consider seeding in a
>    Web Worker (the snapshot worker already exists).
> 2. **Geometry has to arrive too.** With no model URL, the recipient needs
>    geometry, not just properties. ✅ **Decided: hybrid.** (a) **client
>    re-tessellation** — seed parametric placement/profile params and re-run
>    the viewer's WASM geometry kernel locally (smallest payload) wherever the
>    kernel is bit-deterministic; (b) **mesh blobs** — bake meshes into the
>    content-addressed blob store (`blob-route.ts`) and reference them from
>    `GeometryRef` as the universal fallback (imported meshes, non-deterministic
>    primitives). A per-`GeometryRef` flag records which path was used so the
>    recipient knows whether to re-tessellate or fetch a blob.

### 4.3 Mutation flow (legacy STEP, M2)

```
User edits a property in PropertyEditor.tsx
        │
        ▼
mutationSlice → StoreEditor (@ifc-lite/mutations)   ← local model updates (unchanged)
        │
        ▼  (only when a collab session is bound)
bindMutationsToCollab.setProperty(expressId, pset, prop, value)
        │  resolveEntity(expressId) → "/<GUID>"
        ▼
session.transact(() => setPropertyValue(doc, guidPath, …))   ← CRDT write
        │
        ▼  y-websocket → collab-server (role check) → all peers
Remote peers' Y.Doc updates → observer → apply back into their StoreEditor
```

The **return path** (remote CRDT change → local model) is the one new piece of
glue: a Y.Doc observer that maps `guidPath → expressId` (inverse map) and
replays the change through `mutationSlice` *without* re-broadcasting (guard by
transaction origin — the session already tags origins).

### 4.4 Geometry for STEP (M3)

- Property/relationship edits (M2) cover ~80% of real collaborative BIM
  workflows and need no geometry sync.
- For geometry edits (move/rotate/add element — the viewer supports these via
  placement-edit chains), reuse the `geometry/blob-store.ts` +
  `GeometryRef { params }` model. Placement transforms are small param maps →
  trivially CRDT-able. Mesh replacement uses the content-addressed blob store +
  conflict surface (both peers keep their blob; badge shown).
- Determinism caveat (open problem in `collab-plan.md`): the Rust geometry
  kernel must produce bit-identical meshes for identical params or we fall back
  to blob sync. Tracked there, not re-litigated here.

### 4.5 IFCX models

Strictly easier: `seedFromIfcx` already does the full round-trip end-to-end
(it's tested against the buildingSMART hello-wall fixture). When the loaded
model is `.ifcx`, skip the GUID mapping and seed directly. The viewer simply
branches on file type at session-creation time.

### 4.6 How the recipient gets the model (share-link transport)

A share link has **two jobs**: deliver the model **bytes** and join the collab
**room**. The CRDT only carries the live *edit layer* (§4.2 approach 1), so —
unless we seed the whole model into the Y.Doc — the recipient still needs the
base model from somewhere. This is the one piece neither package provides today.

**Reuse the embed viewer's URL pattern, not the embed app.** The embed viewer
(`apps/viewer-embed`) already loads a model from `?modelUrl=https://…`
(`bridge/urlParams.ts`, `EmbedViewer.tsx`) — the recipient's browser
`fetch()`es the bytes and parses locally. The main viewer has the same hook via
`?model=<url>` (`ViewerLayout.tsx:61`). But that URL must be **publicly
fetchable** (http/https only — `data:`/`blob:` rejected), so it assumes the
model is *already hosted*. The embed app itself is chrome-less (no toolbar /
panels / Share button), so collab lives in the **full viewer**; we reuse the
`?modelUrl` *mechanism*, and the embed app can later become a read-only
`viewer`-role presentation of a room.

Three transports, shipped in order:

| # | Transport | Share link | New infra | When |
|---|---|---|---|---|
| 1 | **Public URL** (embed today) | `?model=<url>&room=…&t=…` | none | model already on a CDN/server (fallback) |
| 2 | **Upload-on-share** | `?model=<blobUrl>&room=…&t=…` | reuse `collab-server/blob-route.ts` | recipient already has-or-fetches the file |
| 3 | **Seed-into-room** ✅ **chosen** | `?room=…&t=…` (no model url) | `seedFromStep` (pulled into M1) | "just send a link", offline-capable |

- **(2) Upload-on-share is the missing piece, and it's small.** The
  collab-server **already ships a content-addressed blob route**
  (`packages/collab-server/src/blob-route.ts`, with size limits). On Share, PUT
  the model to it (or an S3 presigned URL), get a content-hashed URL back, and
  bake it into the link. Content addressing **pins an immutable base version** —
  essential, because every peer must seed its edit-layer from the *exact same*
  bytes or GUID-keyed edits won't line up. (Room id is owner-minted — §4.1 —
  independent of this hash.)
- **(3) Seed-into-room is the truest "send a link" UX — and the chosen
  default.** The owner seeds the full model into the Y.Doc (`seedFromStep`,
  M1); the recipient hydrates the model **through the CRDT sync itself** — no
  separate fetch, and IndexedDB makes it offline-capable. Cost: a larger Y.Doc
  (whole model, not just edits) and the STEP→CRDT seeder must land in M1.

**Decision:** ship transport **(3) seed-into-room** as the default. The share
link is just `?room=…&t=…`; the recipient hydrates the model **through the Y.Doc
sync** (offline-capable via IndexedDB), with geometry arriving by client
re-tessellation or mesh blobs (§4.2 consequence 2). This pulls the
`seedFromStep` seeder forward into M1. Transports (1)/(2) remain as fallbacks
when the recipient can cheaply get the bytes locally (then we sync only the
edit-layer diff instead of the whole model).

---

## 5. Architecture & data flow

```
                         ┌───────────────────────────────────────────┐
   Browser A (owner)     │            collab-server (Node)            │     Browser B (guest)
 ┌───────────────────┐   │                                           │   ┌───────────────────┐
 │ apps/viewer        │  │  startCollabServer({                       │  │ apps/viewer        │
 │  Zustand store     │  │    authenticate: verifyRoomToken,  ◄───────┼──┤  (?t=<token>)      │
 │  ┌─ collabSlice ─┐ │  │    persistence: S3/Redis,                  │  │  collabSlice       │
 │  │ session       │◄┼──┼──► Room (Y.Doc + Awareness)  ──────────────┼─►│  session           │
 │  │ presence      │ │  │      • applyUpdateOrDeny (role)            │  │  presence overlay  │
 │  └───────────────┘ │  │      • path-locks (commenter→comments)    │  │                    │
 │  mutationSlice ────┼─►│      • audit-log / rate-limit / replay     │  │                    │
 │  PropertyEditor    │  │                                           │  │                    │
 └────────┬───────────┘  └───────────────┬───────────────────────────┘  └───────────────────┘
          │  POST /collab/token (owner only)                │ periodic .ifcx snapshot
          ▼                                                 ▼
   ┌──────────────┐                                  ┌──────────────┐
   │ token service│  (apps/api route or server route)│ object store │
   │  sign/verify │                                  │ (.ifcx out)  │
   └──────────────┘                                  └──────────────┘
```

- **Transport:** `'indexeddb+websocket'` provider. IndexedDB gives instant
  reopen + offline edits that converge on reconnect; websocket gives realtime.
- **Hosting:** collab-server is a single Node process (`pnpm collab:server`
  already runs it). For prod: container + Redis (presence/locks) + S3
  (persistence/snapshots). Document in `docs/guide/`.

---

## 6. Comments / BCF as the `commenter` tier

To make `commenter` meaningful (write comments but not the model), we put
comments **in the CRDT** rather than offline BCF:

- Add a `comments` top-level `Y.Map` (or a reserved `/comments/*` path subtree)
  carrying BCF-shaped topics/comments/viewpoints, keyed by topic GUID.
- The existing `bcfSlice.ts` / `BCFPanel.tsx` UI binds to it; `bcfAuthor`
  becomes the ephemeral presence identity.
- Server enforcement: a `verifyMessage`/`path-locks` rule that lets
  `commenter` principals write **only** under `comments/*` and reject anything
  else. `viewer` can write nothing; `editor`/`admin` write everything.
- Comments still export to a real BCF `.zip` via `@ifc-lite/bcf` (unchanged) —
  now collaboratively authored.

This gives the three-tier access model real semantic teeth and reuses the BCF
investment.

---

## 7. Viewer integration tasks (file-level)

> **Status (scaffolding landed):** the slice, identity, Share dialog, deep-link
> join, and presence overlay mount are in `apps/viewer` behind `collab.enabled`.
> The collab runtime is lazy-imported (code-split) so the feature ships dark.
> Remaining: seeding, mutation binding, conflict UX, token service, avatars.

### 7.1 New store slice — `collabSlice`

`apps/viewer/src/store/slices/collabSlice.ts`:

- ☑ `session: CollabSession | null`, `status`, `role`, `peers` (from presence),
  `localIdentity { name, color }`, `roomId`.
- ◐ `startCollab({ roomId, token, role, seed })` → lazy `createCollabSession`,
  presence + status subscriptions, and owner-side `seedFromStep` on first sync.
  GUID↔expressId maps, mutation binding, and remote→local observer remain
  (M2, §7.5).
- ☑ `stopCollab()` → `session.dispose()`, teardown.
- ◐ Selectors: `canCollabEdit` / `canCollabComment` (role gates) done; `isShared`
  derivable from `collabRoomId`.

### 7.2 Identity slice (ephemeral)

- ☑ `localStorage`-backed `{ id, name, color }` (`lib/collab/identity.ts`);
  friendly name + FNV-1a color (replicated locally to avoid an eager collab
  import). `setCollabIdentity` reflects renames into live presence. Inline
  editing in the dialog is a follow-up.

### 7.3 Share UI

- ☑ `ShareDialog.tsx` — access picker (view/comment/edit), link with token,
  copy, "live now" presence list. Expiry/revoke + real token minting pending
  (§7.7).
- ☑ Share button in `MainToolbar.tsx` (flag-gated, beside Export) with a live
  peer-count badge. `MobileToolbar.tsx` is a follow-up.
- ☑ `?room=`/`?t=` deep-link auto-join in `ViewerLayout.tsx`.

### 7.4 Presence rendering

- ☑ `CollabPresenceLayer.tsx` mounts `mountPresenceInViewer({ session,
  container, viewport })` over `[data-viewport]` (lazy import). Uses the 2D
  cursor fallback for now.
- ☐ Supply `raycastToWorld` from the renderer's picking so cursors anchor in 3D.
- ☐ Avatar stack in the toolbar/StatusBar; selection halos from peers'
  `presence.selection`.
- ☐ Settings toggle (existing settings panel) to hide others' cursors.

### 7.5 Mutation binding + remote apply

- ◐ `lib/collab/mutation-bridge.ts` mirrors local **property** (set/delete) and
  **attribute** edits into the CRDT, keyed by GUID path (built from the parsed
  store). Wired into `mutationSlice.setProperty/deleteProperty/setAttribute`
  (active model only), no-op without a session. Quantities / pset-create /
  geometry edits are follow-ups.
- ☑ Remote-change observer (`attachRemoteApply`, `observeDeep` filtered by
  `txn.local`) replays peers' edits straight into the `MutablePropertyView` —
  no undo-stack pollution, no echo. Needs live multi-peer verification.

### 7.6 Conflict UX

- ☐ Subscribe to `session.conflicts` / `conflicts/ui-bridge` → render the
  ghost/keep-mine/keep-theirs badge (new small component) + a "deleted while
  you edited — restore?" toast.

### 7.7 Token service

- ☐ `POST /collab/token` + `verifyRoomToken` `AuthenticateFn` **as a route on
  the collab-server** (co-located with the persistence backend used for
  revocation). Secret + key rotation via env.
- ☐ Revocation deny-list in the collab-server persistence backend.

### 7.9 Model transport for recipients (§4.6 — seed-into-room)

- ◐ Owner mints a random room id on Share and seeds the model into the Y.Doc
  via `seedFromStep` once the room syncs (only if still empty). The viewer-side
  `buildStepSeedSource` adapter (`lib/collab/step-seed.ts`) walks the parsed
  `IfcDataStore` → GUID-keyed entities + core attributes. Persisting the
  model→room map in `localStorage` is a follow-up.
- ☑ Bare `?room=…&t=…` link (no model url); recipient joins and hydrates
  entities from the Y.Doc. **Geometry** hydration (re-tessellation / mesh blobs
  — §4.2 consequence 2) and **psets** in the seed are the next follow-ups.
- ☐ Optional fallback: when the recipient already has the file locally, seed
  only the edit-layer diff instead of the whole model.

### 7.8 Packaging

- ☐ Add `@ifc-lite/collab` to `apps/viewer/package.json`.
- ☐ Feature flag `collab.enabled` (env / settings) so it ships dark.
- ☐ Changeset (touches published `@ifc-lite/collab` if any export is added).

---

## 8. Milestones

Each milestone is shippable behind `collab.enabled` and has a hard exit gate.

### M1 — Seed-into-room + presence + comments MVP · ~3–4 wk
**Goal:** Owner clicks Share → sends a bare `?room=…&t=…` link → recipient
opens it, the model **reconstructs from the Y.Doc** (no file, no model URL),
and they see each other's cursors, selections, and avatars; comments sync live.
- **STEP → CRDT seeder** (`seedFromStep`, pulled forward from old M2.5): owner
  seeds the full parsed model into the Y.Doc on Share; geometry via client
  re-tessellation or mesh blobs (§4.2 consequence 2).
- Cold-join perf pass: seed in the snapshot Web Worker; measure against §15
  budget; periodic `.ifcx` server snapshot for durability.
- collabSlice (presence only), ephemeral identity, Share dialog (link mint),
  deep-link join, `mountPresenceInViewer`, avatar stack, comment subtree +
  BCF binding, token service (viewer/commenter/editor minting; only
  commenter+ write comments).
- **Exit:** a recipient with **only the link** reconstructs the model + geometry
  and joins; live cursors + selection halos + shared comments across two
  browsers; `viewer` role provably cannot write (server drops it); links
  expire/revoke.

### M2 — Property editing over legacy STEP · ~2 wk
**Goal:** `editor`s change properties and everyone converges.
- GUID↔expressId maps, `bindMutationsToCollab`, remote→local observer,
  per-user undo isolation, conflict badge for concurrent property writes.
- **Exit:** two editors change Pset values on the same wall; LWW resolves;
  loser notified; export reflects merged state; `commenter` blocked from
  property writes server-side.

### M3 — Geometry editing · ~2–3 wk
**Goal:** Collaborative move/rotate/add-element.
- Placement params as CRDT, mesh blob store + conflict surface, determinism
  validation/fallback, ghost overlay for concurrent moves.
- **Exit:** two peers move/add elements; deterministic params converge; mesh
  conflicts surface a badge, never corrupt.

### M4 — Production hardening · ~1–2 wk
**Goal:** Run it for real.
- Redis + S3 persistence, key rotation, audit dashboards, rate limits tuned,
  reconnect/offline-edit convergence tests, 24 h soak with 5 peers, deploy
  guide in `docs/guide/`.
- **Exit:** soak passes with no leaks; offline edits converge; access controls
  audited.

---

## 9. Security & privacy

- **Authorization on the server, not the client.** UI role gating is UX;
  `applyUpdateOrDeny` + `path-locks` are the real control. A `viewer` token
  cannot be hand-edited into write access (signed JWT, server-enforced role).
- **Link == capability.** Anyone with the link has that role — same trust model
  as Google Docs "anyone with the link". Default TTL 7 days; owner can revoke
  (rotate `kid`) and set shorter expiry. Communicate this clearly in the
  Share dialog.
- **No PII collected** (accountless) — ephemeral handles only. Audit log keys
  on the token `jti`/ephemeral id, not real identity.
- **Transport:** WSS/TLS (server already ships a TLS baseline);
  optional at-rest encryption for stored Y-state/blobs is tracked in
  `collab-plan.md` §5.6.
- **Abuse:** per-token rate limits (already in the server); room caps;
  blob size limits (already in `blob-route.ts`).

---

## 10. Decisions (resolved)

All forking decisions are now settled; this section is the record.

1. **Identity / auth** — ✅ **accountless, link-based.** Role rides in a signed
   room token; ephemeral handle + color in `localStorage`. (§2.2, §3)
2. **Recipient transport** — ✅ **seed-into-room.** Bare `?room=…&t=…` link;
   model arrives through the Y.Doc. (§4.6)
3. **Seed strategy** — ✅ **full STEP seed from M1** (`seedFromStep`), with
   edit-layer-only as the local-file fallback. (§4.2)
4. **Geometry transport** — ✅ **hybrid:** client re-tessellation where the
   WASM kernel is deterministic; content-addressed mesh blobs as the universal
   fallback, flagged per `GeometryRef`. (§4.2 consequence 2)
5. **Room-id derivation** — ✅ **owner-minted random id** (explicit "start a
   shared session"); model→room mapping in the owner's `localStorage`. (§4.1)
6. **Result export** — ✅ **IFCX (IFC5) snapshot only for now** via the existing
   `to-ifcx` path, plus the current `ExportChangesButton` change-set for STEP.
   No new CRDT→STEP `.ifc` writer in scope; revisit if legacy round-trip is
   demanded. (§4.2)
7. **Token service home** — ✅ **route on the collab-server** (`POST
   /collab/token` + `verifyRoomToken`), co-located with the revocation store.
   (§3.1, §7.7)
8. **Mobile** — ✅ presence + comments on `MobileToolbar` in M1; mobile
   *editing* deferred.

**Remaining to confirm after M1's perf pass (measurement-driven, not a fork):**

- **Y.Doc size budget** — a full-model seed (100k+ entities) in the Y.Doc.
  Measure cold-join against the §15 budget; set a provisional shareable-model
  size cap and decide whether large models force the edit-layer fallback or a
  worker-side incremental seed.

---

## 11. Relationship to `collab-plan.md`

That document tracks the *package* roadmap (v0.1→v1.0). Most of what this plan
consumes is already ☑/◐ there:

- Presence/awareness (v0.2 §2.3) — landed; viewer rendering (§2.4) is *this*
  doc's M1.
- Authorization/roles (v0.5 §5.1) — landed server-side; link-token minting is
  *this* doc's new bit.
- Geometry CRDT (v0.3) — foundations landed; viewer conflict badge (§3.5) is
  *this* doc's M3.
- Federation (v0.4) — landed; multi-model shared rooms are a post-M4 follow-up.

This plan adds **no new package roadmap items** except, both in M1 and both
small/additive: the `from-step.ts` seeder (`seedFromStep`) and the link-token
`AuthenticateFn` + `POST /collab/token` route on the collab-server.
