# 05 — Flavors and Sharing

A **flavor** is a user's complete personalization layer. This document
specifies the flavor data model, the import/export format, the
three-way merge semantics for "borrow my colleague's flavor," and the
later-phase registry. The design borrows from Home Assistant blueprints,
VS Code settings sync, and Obsidian community plugins, with key
adjustments for our security model.

## 1. What is in a flavor

```ts
interface Flavor {
  schemaVersion: 1;
  id: string;                     // local UUID
  name: string;                   // user-facing label
  description?: string;
  createdAt: string;              // ISO timestamp
  updatedAt: string;

  /** Installed extensions with pinned versions and granted capabilities. */
  extensions: FlavorExtension[];

  /** User-curated lens presets beyond the built-ins. */
  lenses: SavedLens[];

  /** User-curated query / IDS rule presets. */
  savedQueries: SavedQuery[];

  /** Keybinding overrides. */
  keybindings: KeybindingOverride[];

  /** Panel layout. */
  layout: LayoutOverride;

  /** Personal prompt overlay (see 06). */
  promptOverlay?: PromptOverlay;

  /** Default settings overrides. */
  settings: Record<string, JsonValue>;

  /** Optional author / signing metadata if exported. */
  author?: FlavorAuthor;
}

interface FlavorExtension {
  id: string;
  version: string;                // semver
  source: 'local' | 'registry' | 'url';
  /** Hash of the bundle for integrity. */
  bundleHash: string;             // sha256 hex
  /** Capabilities the user granted on install. */
  grantedCapabilities: Capability[];
  /** User-level config (forms etc.) the extension persisted. */
  config?: Record<string, JsonValue>;
  /** Whether this extension is currently enabled. */
  enabled: boolean;
}
```

A flavor is a value, not a reference. Two users with the same flavor
have the same configuration even if one is offline.

## 2. Storage

Flavors live in IndexedDB under the `flavors` object store, keyed by
`id`. Extension bundles live in a separate `extension-bundles` store
keyed by `(id, version)`. A flavor references bundles by id+version+hash.

The user has one **active flavor** at a time. The active flavor's
contributions are loaded on app start. Switching flavors:

- Deactivates the current flavor's extensions.
- Loads the new flavor's extensions (validating bundles by hash).
- Re-renders affected slots.
- Applies keybindings, layout, prompt overlay, settings.

A flavor switch is a fully observable event. The status bar surfaces
"Flavor: Architecture (default)" so the user always knows which one is
active.

## 3. Export

A flavor exports to a single JSON document. By default, exports include:

- The full `Flavor` object.
- Each `FlavorExtension`'s bundle (manifest + code + widgets + tests),
  inlined as a base64 payload.
- A file signature header (magic bytes + format version).

The file is gzipped and the resulting bytes get the extension `.iflv`
(IFC-Lite flavor; mirrors `.iflx` for individual extensions).

Optional export flags:

- `--minimal` — references registry extensions by id+version+hash
  instead of inlining their bundles. Smaller files; recipient must
  have or fetch the same registry version. Useful for sharing
  configurations of common community extensions.
- `--strip-config` — omits per-extension config and personal prompt
  overlay. Useful for "share the structure, not my data."

The exporter produces a **summary file** alongside the bundle:

```
Flavor: "Residential Architect"
Author: alice@example.com
Created: 2026-04-12
Extensions (3):
  - Fire Rating Report v1.3      (caps: model.read, export.create:csv)
  - Quick Section Toolbar v2.1   (caps: viewer.section, viewer.fly)
  - Storey QTO Lens v0.4         (caps: model.read)
Lens presets: 5
Saved queries: 12
Keybindings: 4 overrides
Layout: custom right dock
Prompt overlay: present (412 chars)
```

The summary is shown to the user on every export and import. It is
not a security feature on its own (an attacker controls it) but it is
the basis of the import review screen.

## 4. Import

Importing a flavor is a privileged operation. It surfaces a review
screen comparable to the per-extension review, but at flavor scope.

The flow:

1. User drops a `.iflv` file or pastes a flavor URL.
2. The host validates the file signature and gzip header.
3. The host validates the embedded flavor against the v1 schema.
4. The host renders a **diff view** comparing the incoming flavor to
   the active flavor:
   - Extensions added (with capability badges).
   - Extensions removed.
   - Extensions whose version differs (with capability diff).
   - Lenses / queries / keybindings added or removed.
   - Layout / settings changes.
5. The user chooses one of:
   - **Apply** — replace active flavor wholesale.
   - **Save as new flavor** — keep current; new flavor sits beside it.
   - **Merge** — see §6.

Every extension contained in the flavor passes through the per-extension
capability review. The user cannot blanket-approve everything; they see
each extension's risk badges. If any extension is flagged red, the
review screen surfaces it prominently.

## 5. Three-way merge

If the user picks "Merge," the host computes a three-way merge against:

- **Base** — the common ancestor flavor, if known (recorded at the time
  of original sharing). If unknown, use the current active flavor as
  pseudo-base.
- **Theirs** — the incoming flavor.
- **Ours** — the active flavor.

Merge resolves:

- **Extensions** — union by id. Version conflicts default to the higher
  semver; user can override per-row.
- **Capabilities** — per-extension; conflicts default to the intersection
  (the more restrictive set), user can opt up.
- **Lenses, saved queries** — union by id; same-id conflicts surface
  side-by-side.
- **Keybindings** — last-write-wins per key, user reviews conflicts.
- **Layout** — incoming wins by default.
- **Settings** — per-key: incoming wins for unknown keys; conflicts on
  known keys surface for review.
- **Prompt overlay** — appended with a clear separator.

The merge result is editable before commit. We render the merge as a
side-by-side diff UI: green for additions, red for removals, blue for
modifications, with checkbox per row.

This is the Home Assistant blueprint pattern applied to flavors. Users
get the productive use of "borrow Alice's setup" without losing their
existing customisation.

## 6. URLs and links

A flavor can be shared by URL:

```
https://ifclite.com/f/<id>
```

The URL resolves to a hosted bundle the recipient downloads on demand.
This is the only network feature of the flavor system; everything else
is local-only.

The hosted URL is opt-in: users explicitly publish a flavor by clicking
"Share" → "Create public link." Published flavors are immutable; a new
share produces a new URL. Unpublishing removes the URL from the host but
does not pull existing copies (impossible by design).

URL flavors are subject to the same import review as file flavors. They
are not implicitly trusted by virtue of having a URL.

### 6.1 Anti-abuse for hosted URLs

- Per-account rate limit on publish.
- Server-side scan: malformed flavors rejected at upload.
- Server-side capability flag-check: any flavor with extensions
  requiring `network.fetch:*` or `model.mutate:*` wildcards gets a
  warning banner on the public URL.
- Takedown mechanism for reported abusive flavors. Not a registry yet
  (that is Phase 4); this is the lightweight cousin.

## 7. The registry (Phase 4, sketched here)

A registry is a curated, signed, browsable catalogue of community
flavors and extensions. We do not ship it in v1. The design constraints
when we do:

- Authors sign their bundles with Ed25519 keys registered to their
  account.
- Every submission passes a CI suite:
  - Manifest validation.
  - Capability hygiene (no wildcard fetch / mutate without
    justification).
  - Test pass against canonical fixtures.
  - Lint pass (no banned globals, no `eval`).
  - License declared (SPDX).
- Updates require a new signed bundle; capability diff is surfaced in
  the listing.
- The registry surfaces an *editorial pick* lane (curated by us) and a
  *community* lane (signed but uncurated). Different default trust
  posture.
- A built-in *report this extension* flow that feeds into a takedown
  pipeline.
- Statistics are aggregate only (install count, weekly active,
  capability bucket distribution). No per-user identifiers leave the
  device.

We will not build a marketplace with payments, paid listings, or
sponsored placement.

## 8. Versioning a flavor

Flavors carry their own `schemaVersion` (currently 1). When we add new
fields, we migrate older flavors on load. A future migration that
breaks compatibility (`schemaVersion: 2`) ships with:

- A migration function in `@ifc-lite/extensions/flavors/migrations/`.
- A user-facing note about what changes.
- A safety net: the pre-migration flavor is archived locally and can be
  restored within 30 days.

## 9. Recovery and safety nets

A flavor is the user's environment. Breakage is severe. Safeguards:

- **Auto-snapshot on change.** Every flavor edit produces a snapshot;
  last 10 snapshots are retained per flavor.
- **Reset to defaults.** A one-click "reset to a baseline default
  flavor" always works; this is the panic button.
- **Safe-mode launch.** Holding shift while launching (desktop) or
  `?safe=1` query (web) starts with no flavor active. Useful when an
  extension makes the app unusable.
- **Kill-switch hook.** A host-side blocklist (deployed with the build)
  can refuse to load specific extension ids; this is the last resort
  for known-bad community extensions.

## 10. Interaction with desktop / server

The desktop app loads flavors the same way as the browser. Flavors that
declare `desktop`-specific features (e.g. file system access through a
future `system.fs:<path>` capability) are flagged accordingly.

The server (headless backend) loads flavors and runs activations for
non-viewer triggers (e.g. an exporter that runs on file upload). UI
contributions are no-ops on the server. The same manifest works
everywhere; capabilities the server cannot grant fail the activation
visibly.

The MCP server (`packages/mcp`) exposes flavor management as MCP tools:
`flavor_export`, `flavor_import`, `flavor_list`, `flavor_activate`.
External agents can therefore curate flavors against a running
IFClite instance.

## 11. Diff and audit UI

Every change to a flavor — extension install, capability re-grant,
keybinding change, prompt overlay edit — appears in the flavor's audit
log. The log:

- Is local-only.
- Shows what changed, when, and by whom (user, AI suggestion accepted,
  flavor merge).
- Is exportable as JSON.
- Powers the "what did this flavor do to my app?" review the user can
  call up at any time.

## 12. Migration: from saved scripts to flavors

When a user with existing saved scripts (`savedScripts` in the viewer
store) opens IFClite after the flavor system ships:

- A one-time migration offers to promote saved scripts into a
  **starter flavor** named "My scripts," with each script as a minimal
  extension.
- The migration is opt-in and reversible.
- Untouched users keep their saved scripts working unchanged; the
  flavor system is additive.

This avoids a hard cutover and respects the existing UX.
