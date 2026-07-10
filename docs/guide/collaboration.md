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
