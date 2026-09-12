# Real-Time Collaboration

Share a model with a link and work on it together — live cursors, a shared
spatial tree, synced edits, and a presence roster. No accounts: access is
carried entirely by the share link.

!!! info "How it works in one line"
    The model lives in a [CRDT](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type)
    room (IFCX-native). The owner seeds it from their open model; everyone else
    joins by link and the viewer **reconstructs the model from the room** — so a
    recipient needs no file, just the link.

## Enabling collaboration

Collaboration ships behind a flag so it stays out of the way until you want it.

| How | What |
| --- | --- |
| Build env | Set `VITE_COLLAB_ENABLED=true` (and a server URL — see below) when building/serving the viewer. |
| Per-browser (dev) | In the browser console: `localStorage.setItem('ifc-lite:collab:enabled', 'true')`, then reload. |

When enabled, a **Share** button appears in the toolbar (it's active once a model
is loaded). To sync across machines you also need a [collaboration server](collab-server.md);
without one the feature runs **local-only** (one browser, multiple tabs) — handy
for trying it out.

## Sharing a model (owner)

1. Load a model.
2. Click **Share** in the toolbar.
3. Choose what anyone with the link can do:

    | Access | Can… |
    | --- | --- |
    | **View** | See the model, the spatial tree, properties, and other people's cursors. |
    | **Comment** | …also add issues and markups. |
    | **Edit** | …also change properties and geometry. |

4. Click **Copy** and send the link. It looks like `https://…/?room=<id>&t=<token>`
   and expires after 7 days.

Opening the dialog puts you in the room as **admin** and starts sharing your
model into it. You can re-copy a link at any access level, and you stay admin
for the room.

### Sharing several models

With more than one model loaded, the dialog first asks what the room should
carry, and creates the room only when you press **Create link**:

| Scope | The room holds… |
| --- | --- |
| **All N loaded models** (default) | Every loaded model, each as its own model. Recipients see the whole workspace and can pick, edit and export each model separately (a second copy of a file is listed as "name (2)"). N counts the models that can be shared: a GLB, a point cloud or a model still loading has nothing to put in a room, and the option says "All 2 of 3 loaded models" when one is left out. |
| **Active model only** | The model that is active in the hierarchy. The others stay private. |

Each shared model gets its own *slot* in the room, so two copies of the same
file — same file name, same bytes, same IFC GlobalIds — stay two distinct
models with their own geometry, placement and textures. The scope is fixed once
the room exists; re-opening the dialog shows how many models the room carries.
While several models upload, the progress row names the model it is on
("model 2 of 3"). A recipient exports each room model to its own `.ifcx`
(merged export is STEP-only); the file carries the model's own `/<GlobalId>`
paths, never the room's slot, so it opens in any viewer and diffs against the
other copy's export.

Textured models share their UV coordinates and image pixels with the geometry.
Recipients do not need the original IFCZIP or access to its image filenames.
Images are shared once per content hash, with each surface retaining its wrap
settings. Each decoded image is limited to 16,777,216 pixels total (4096 × 4096),
with at most 8192 pixels on either side; an unavailable or
oversized image is reported as a sharing failure instead of silently dropping
its appearance.

Both owner and recipient need a viewer version that supports textured room
geometry. Older rooms that were shared without texture data cannot recover it
from the link: load the original textured IFCZIP and create a new share.

## Joining (recipient)

Open the share link — that's it, no account needed. The viewer joins the room
and reconstructs the model:

- the **3D model renders**,
- the **HIERARCHY** panel and explorer (Spatial / Class / Type) populate,
- clicking an element fills the **INSPECTOR** with its attributes and properties,
- **edits made by others appear live**.

!!! note "Recipients work from the room, not a file"
    A recipient never downloads the original IFC. The model is rebuilt from the
    shared room as IFCX, with geometry streamed as content-addressed blobs. This
    works for both IFC5/IFCX rooms and legacy STEP (IFC2x3/IFC4) rooms.

## The room panel

While you're in a room, a **people** button appears in the toolbar (with a live
participant count). It opens the **Room** panel:

- **Connection + room id** — a live status dot (Live / Connecting / Offline).
- **Roster** — everyone present: colour dot, name, **role badge**, and current
  activity (active / idle / measuring …). You're marked *(you)*.
- **Copy invite link** — mint and copy a fresh link.
- **Leave room** — disconnect and return to solo editing.
- **Admins** additionally get:
    - **Revoke link** — invalidate the last share link you handed out; anyone
      trying to join with it afterwards is refused.
    - **Remove** (hover a peer) — disconnect a participant; their link is revoked
      so they can't immediately rejoin.

## Roles

Roles are baked into the share link and **enforced by the server** (when one is
configured), so a link's holder can't escalate their own access.

| Role | Read | Comment | Edit | Manage |
| --- | --- | --- | --- | --- |
| Viewer | ✓ | | | |
| Commenter | ✓ | ✓ | | |
| Editor | ✓ | ✓ | ✓ | |
| Admin (owner) | ✓ | ✓ | ✓ | ✓ (revoke / remove) |

## Privacy & limitations

- The share link **is** the credential — anyone with it gets that role until it
  expires (7 days) or an admin revokes it.
- A recipient sees the model's structure and properties, but **native material
  and classification *cards*** that need the original file bytes are surfaced as
  plain property groups instead. Geometry, hierarchy, names, properties,
  classifications, and materials are all available.
- Per-peer **role *changes*** aren't supported — access comes from the link
  (issue a new link / revoke the old one instead). Admins can **remove** a peer.
- See also [Privacy](privacy.md) for the data-handling disclosure.

## Running it yourself

- **Try it locally (no server):** enable the flag and open the viewer in two
  browser tabs — they sync through the browser. Geometry + presence work; this
  is the quickest way to see it.
- **Multi-user across machines:** stand up the [collaboration server](collab-server.md)
  and point the viewer at it. That guide covers signed links, revoke/kick, and
  deployment.
