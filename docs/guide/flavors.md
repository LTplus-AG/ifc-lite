# Flavors

A **flavor** bundles your customisations into a single switchable, exportable, importable profile. One flavor for cost estimating with the quantity-takeoff extension, your fire-rating lens, and CSV-with-semicolons defaults. Another for design review with markup tools and a different lens library. Switch between them with one click.

This guide covers managing flavors through the status-bar chip. For the technical model (three-way merge semantics, snapshot retention, the `.iflv` envelope) see [the RFC](../architecture/ai-customization/05-flavors-and-sharing.md).

## What's in a flavor?

A flavor stores:

- **Extension list** — which `.iflx` bundles are part of the flavor (with their granted capabilities)
- **Lenses** — saved visualisation states (color by type, isolate by storey, etc.)
- **Saved queries** — named filter expressions
- **Keybindings** — keyboard shortcut overrides
- **Layout state** — panel sizes, dock arrangement
- **Settings** — viewer preferences (units, separators, default colors)
- **Prompt overlay** — durable notes the AI assistant sees in every chat (see [Privacy](privacy.md#prompt-overlay))

Switching a flavor:

1. Disables every installed extension that's not in the target's list.
2. Enables + loads every extension that is in the target's list.
3. Applies the target's lenses, settings, keybindings, layout.
4. Moves the active-flavor pointer.

If any step fails the host rolls back: the previously-active flavor's state is restored, the pointer doesn't move, and the UI shows a structured error.

## The status-bar chip

The status bar at the bottom of the viewer shows a small palette icon with the active flavor's name (or **Default** when none is active). Click it to open the **Flavors dialog**.

![Status bar chip](TODO: screenshot — status bar with palette icon)

## The Flavors dialog

### List view

Every flavor appears with:

- Name + active badge (when it's the current flavor)
- Stable id (used for `.iflv` round-trips)
- Description if set
- Counts: extensions / lenses / queries / last-updated date
- Per-row controls: **Activate**, **Export**, **Delete** (active flavor can't be deleted)

Header actions:

| Button | What it does |
|--------|-------------|
| **Import** | Load a `.iflv` file → preview screen |
| **Reset** | Create / restore the baseline flavor with no extensions or overrides |

### Activate

Click **Activate** on any non-active row to switch. The host:

1. Locks the UI briefly while the switcher runs.
2. Reports each disabled / enabled extension in the toast.
3. On failure, shows which extensions could not load and rolls back to the prior flavor.

!!! info "Already-correct extensions are not reloaded"
    If an extension is part of both the source and target flavor and already enabled, the switcher leaves it alone — no unnecessary deactivate / reactivate cycle.

### Export

Click the download icon on a flavor row. The flavor serialises to a `.iflv` file (gzipped JSON envelope with a magic header + version) and downloads with the filename `<flavor-id>.iflv`.

What goes into the export:

- The flavor's full state (extensions list, lenses, queries, keybindings, layout, settings, overlay)
- **No extension bundle bytes by default** — the `.iflv` references extensions by id + version. To produce a portable export that includes the bundles, use the future `--include-bundles` flag (Phase 5).
- **No personal data** — the action log and audit log do not travel with a flavor.

### Import

Click **Import** in the header (or drop a `.iflv` on the dialog). The viewer:

1. Decompresses the envelope, verifies the magic + version, runs the flavor through the validator.
2. Shows a **preview**: name, id, description, content counts.
3. Offers three actions:

    - **Merge…** — three-way merge against your active flavor (see [Merging](#merging))
    - **Save as new** — import with a fresh id (`<original>.imported-<ts>`), no collisions
    - **Replace existing** — overwrite a flavor with the same id

The preview screen also surfaces any embedded summary the exporter wrote (a free-text note explaining what the flavor is for).

### Reset

**Reset** restores the baseline `flv.default` flavor — empty extensions, no lenses, no overrides — and activates it. Your other flavors are preserved; reset only touches the baseline. Use it as a panic button when a flavor is broken or when you want to start from scratch.

!!! tip "Snapshots"
    Each time you save changes to a flavor (rename, edit overlay, change settings), the storage retains the prior version as a snapshot. The current implementation keeps the most recent 10 per flavor. The restore UI is a follow-up; the snapshots are queryable via the library API today.

## Merging

The merge dialog implements a **three-way merge** between:

- **base** — the stored ancestor (whichever flavor in your library has the same id as the incoming one, if any; otherwise falls back to your active flavor for a two-way compare)
- **theirs** — the incoming `.iflv` you just imported
- **ours** — your currently-active flavor

For each conflict you pick a winner: theirs, ours, or base. Conflict kinds:

| Kind | What conflicts | Default winner |
|------|----------------|----------------|
| `extension_version` | Same extension id, different version | Ours |
| `extension_capabilities` | Same extension, different granted caps | Ours |
| `lens` | Same lens id, different definition | Ours |
| `saved_query` | Same query id, different filter | Ours |
| `keybinding` | Same key, different command | Ours |
| `setting` | Same key, different value | Ours |

For each conflict, the dialog renders a 3-cell (or 2-cell when no base is available) chooser. Pick **Theirs** / **Ours** / **Base** per row, then click **Save merged flavor**.

The merged result is saved under a fresh id (`<their-id>.merge-<ts>`) so neither input is overwritten silently. You can activate it after the dialog closes.

!!! warning "Clean merges don't need conflict resolution"
    If the imported flavor and your active flavor have no overlap (different extensions, different lens ids), the dialog shows "Clean merge — no conflicts" and Save creates the merged result without any choices to make.

## The `.iflv` format

`.iflv` is a gzipped JSON envelope:

```json
{
  "format": "iflv",
  "version": 1,
  "summary": "Optional free-text note explaining the flavor",
  "flavor": { ... full Flavor object ... },
  "extensionBundles": {
    "com.example.my-ext": "<base64 of bundle bytes>"
  }
}
```

- **Magic + version** are checked before any other parsing — a corrupt or mismatched envelope rejects with a structured error, never crashes the viewer.
- **Extension bundles** are optional. A "thin" export lists ids only; a "thick" export embeds the bundle bytes (Phase 5).
- **Max uncompressed size** is enforced during unpack to defend against decompression bombs.

The full schema lives in `packages/extensions/src/flavor/types.ts`; `validateFlavor` runs on every import.

## Safe mode and flavors

[Safe mode](extensions.md#safe-mode) (`?safe=1` in the URL) skips automatic flavor activation. The active-flavor pointer remains set in storage — when you reload without the flag, the original flavor reactivates. Use safe mode if a flavor switch leaves the viewer in a bad state.

## Troubleshooting

??? question "I switched flavors and an extension didn't load"
    Open the Audit tab — failed activations are recorded with the reason (capability denied / bundle bytes missing / entry script not parseable). The switcher already rolled back to your prior flavor; the error is informational.

??? question "Import shows 'unsupported version'"
    `.iflv` files include a schema version. If your viewer is older than the version the file was produced with, you can't import it cleanly. Update the viewer, or ask the author to export against an older schema.

??? question "Merge said 'Clean merge' but I expected conflicts"
    The three-way merger compares by stable identifiers (extension id, lens id, query id, etc.). If the incoming flavor uses different ids for what you considered "the same lens", they'll be treated as additions, not conflicts. You can resolve this by renaming on either side before re-merging.

??? question "My exported `.iflv` won't import on someone else's viewer"
    Two common causes: schema version mismatch (see above), or the extensions in the flavor aren't installed on the target viewer. A "thin" export references extensions by id — the recipient needs to install the actual `.iflx` files separately.

## Next steps

- [Extensions](extensions.md) — install, run, manage individual extensions
- [Authoring extensions](extension-authoring.md) — build your own
- [Privacy](privacy.md) — manage the action log and prompt overlay
