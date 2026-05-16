# Authoring Extensions

You can build extensions two ways: by hand with the CLI, or by asking the AI assistant in the chat panel. Both produce the same `.iflx` bundle format. This guide covers the hand-authoring side; the AI authoring loop is the same pipeline driven through chat.

## Quick start

Scaffold a starter bundle:

```bash
npx @ifc-lite/cli ext init my-tool
```

This creates:

```
my-tool/
├── manifest.json
├── README.md
└── src/
    └── commands/
        └── hello.js
```

The scaffolded `hello.js` is a runnable extension that contributes one command (`ext.starter.hello`) and prints a greeting to the console. Validate it:

```bash
npx @ifc-lite/cli ext validate my-tool
# ✓ my-tool is valid.
```

Pack it into a `.iflx`:

```bash
npx @ifc-lite/cli ext pack my-tool --out my-tool.iflx
```

Drop the `.iflx` onto the Extensions panel in the viewer.

## The manifest

The manifest is the contract between your bundle and the host. Every field is hand-validated — no Zod, no runtime surprises.

```json
{
  "manifestVersion": 1,
  "id": "com.example.fire-rating-check",
  "name": "Fire Rating Check",
  "description": "Highlights walls missing Pset_WallCommon.FireRating.",
  "version": "1.0.0",
  "engines": { "ifcLiteSdk": ">=2.0.0" },
  "capabilities": [
    "model.read",
    "viewer.colorize"
  ],
  "activation": ["onCommand:ext.fire-rating.check"],
  "contributes": {
    "commands": [
      {
        "id": "ext.fire-rating.check",
        "title": "Check fire ratings",
        "category": "Compliance"
      }
    ],
    "toolbar": [
      {
        "command": "ext.fire-rating.check",
        "slot": "toolbar.right",
        "icon": "shield-check"
      }
    ]
  },
  "entry": {
    "commands": {
      "ext.fire-rating.check": "src/commands/check.js"
    }
  },
  "tests": [
    {
      "name": "marks walls missing fire rating",
      "command": "ext.fire-rating.check",
      "fixture": "residential-small",
      "expect": { "jsonShape": { "missing": { "type": "number" } } }
    }
  ]
}
```

### Required fields

| Field | Purpose |
|-------|---------|
| `manifestVersion` | Schema version (currently `1`). The migration chain handles future versions. |
| `id` | Stable reverse-DNS identifier, lowercase, dot/underscore/hyphen-separated. |
| `name` | Display name shown in the Extensions panel and Command Palette. |
| `description` | One-paragraph explanation. |
| `version` | Semver string. |
| `engines.ifcLiteSdk` | SDK range your bundle works against (`>=2.0.0`, `^2.1`, `~2.0.3`, etc.). |
| `capabilities` | Array of capability strings (see [Capabilities](#capabilities)). |
| `activation` | When the host should activate your bundle (`onStartup`, `onCommand:<id>`, `onLens:<id>`, etc.). |
| `contributes` | What your bundle adds to the UI. |
| `entry` | Map from command id → JS file path. |

### Contribution slots

`contributes` is where the UI shows up. Each slot type:

| Slot | What it does |
|------|--------------|
| `commands` | Available in the Command Palette and dispatchable from other slots. |
| `toolbar` | Icon buttons in `toolbar.right` / `toolbar.left`. |
| `dock` | Tabbed panels in `dock.left` / `dock.right` / `dock.bottom`. |
| `contextMenu` | Items in `contextMenu.entity` / `contextMenu.canvas` / `contextMenu.tree`. |
| `keybindings` | Keyboard shortcuts bound to a command. |
| `lenses` | Visualisation presets registered in the lens library. |
| `exporters` | Custom export formats added to the export menu. |
| `idsValidators` | Custom IDS rule validators. |
| `statusBar` | Items in `statusBar.left` / `statusBar.right`. |

Each contribution can carry a `when` clause that gates visibility:

```json
{
  "command": "ext.fire-rating.check",
  "slot": "contextMenu.entity",
  "when": "model.loaded && selection.count > 0"
}
```

The `when` vocabulary is a small allow-list: `model.loaded`, `model.schema`, `model.count`, `selection.count`, `selection.type`, `viewer.open`, `desktop`, `embed`. Unknown keys evaluate to undefined → false.

## Capabilities

Capabilities are the **only** mechanism for an extension to reach beyond its own sandbox. The grammar is:

```
<namespace>.<verb>[:<target>]
```

Examples:

```
model.read
model.mutate:Pset_WallCommon
viewer.colorize
viewer.section
export.create:csv
export.create:*
network.fetch:api.example.com
```

When you declare a capability, the user sees it during install with a plain-English description and a risk badge:

- **Green** — read-only / scoped operations (`model.read`, `viewer.read`)
- **Yellow** — viewer mutations, scoped exports (`viewer.colorize`, `export.create:csv`)
- **Red** — network egress, model mutation, unknown capabilities (`network.fetch:*`, `model.mutate:*`)

!!! warning "Be specific"
    Declare the narrowest capability that works. `model.mutate:Pset_WallCommon` is far less alarming than `model.mutate:*` — and the user is much more likely to grant it.

The full catalogue lives in `packages/extensions/src/capability/catalogue.ts`. The CLI prints it:

```bash
npx @ifc-lite/cli ext capabilities
```

## Writing entry code

Entry files are plain JS — no `export`, no `import`, no module shenanigans. The wrapper injects a `ctx` parameter when it calls your function:

```js
// src/commands/check.js
async function run(ctx) {
  const walls = await ctx.bim.query.byType('IfcWall');
  const missing = [];
  for (const wall of walls) {
    const psets = await ctx.bim.properties(wall.ref);
    const pset = psets.find((p) => p.name === 'Pset_WallCommon');
    const fireRating = pset?.properties.find((p) => p.name === 'FireRating');
    if (!fireRating?.value) missing.push(wall.ref);
  }
  // Visual feedback via the viewer.colorize capability.
  for (const ref of missing) {
    await ctx.bim.viewer.colorize(ref, [1, 0, 0, 1]);
  }
  return { missing: missing.length };
}
```

### What's in `ctx`

| Field | Capability gate | Notes |
|-------|----------------|-------|
| `ctx.bim` | All bim namespaces are reachable through `ctx.bim`. | Method calls are checked at runtime against your granted capabilities; denied calls throw `CapabilityDeniedError`. |

The `ctx.bim` API mirrors the `@ifc-lite/sdk` surface. Run `ifc-lite schema` (no args) to dump the full API tree.

### What's NOT available

- `globalThis`, `window`, `document`, `navigator`
- `fetch` (use `ctx.bim.network` with `network.fetch:<host>` capability)
- `eval`, `new Function(...)`, dynamic `import(...)`
- File system APIs
- Web Workers, WASM instantiation

These are blocked at parse time by the AST walker in `validate/code.ts`. If your code references one, `ext validate` flags it before pack.

### Async handlers

`run` can be `async`. The runtime captures the returned Promise's `value` so test expectations and the activation record have access:

```js
async function run(ctx) {
  const result = await ctx.bim.query.byType('IfcWall');
  return { count: result.length };
}
```

The host never `await`s a long-running entry — async work runs inside the sandbox's microtask queue, and the runtime returns the Promise to the caller.

## Widgets

Widgets are JSON descriptions of UI you contribute to a dock panel. The widget DSL has 15 node types — `Stack`, `Group`, `Text`, `Field`, `Button`, `Table`, `Chart`, `Markdown`, `Tabs`, `Separator`, `EmptyState`, `Spinner`, `ErrorBanner`, `EntityList`, `Tree`, `KeyValueGrid`.

```json
{
  "type": "Stack",
  "direction": "vertical",
  "children": [
    { "type": "Text", "content": "Fire rating audit", "variant": "heading" },
    {
      "type": "Button",
      "label": "Run check",
      "command": "ext.fire-rating.check",
      "tone": "primary"
    },
    {
      "type": "Table",
      "binding": "$.results",
      "columns": [
        { "header": "Wall", "binding": "name" },
        { "header": "Storey", "binding": "storey" }
      ]
    }
  ]
}
```

Bindings (`$.results`, `$.foo.bar`) read from the state your entry function returned. Buttons dispatch commands through the host (capability-checked).

Reference the widget from a `dock` contribution:

```json
{
  "contributes": {
    "dock": [
      {
        "id": "fire-rating-panel",
        "slot": "dock.right",
        "title": "Fire Ratings",
        "widget": "widgets/panel.json"
      }
    ]
  }
}
```

The renderer validates the widget JSON against the DSL schema before mounting; malformed widgets fail gracefully with a structured error.

## Tests

Declare manifest tests so the runner can verify your bundle works. The test runner is the same path the CLI uses for `ext test` and the viewer uses for the Repair queue.

```json
{
  "tests": [
    {
      "name": "wall query returns rows",
      "command": "ext.fire-rating.check",
      "fixture": "residential-small",
      "args": { "minRating": 60 },
      "expect": {
        "jsonShape": { "missing": { "type": "number" } }
      }
    }
  ]
}
```

### Matchers

| Matcher | Purpose |
|---------|---------|
| `mimeType` | Strict equality against `value.mimeType`. |
| `minBytes` / `maxBytes` | Byte-length range on `value.bytes`, `value.text`, or a string return. |
| `regex` | RegExp match against text representation. Capped at 256 chars for safety. |
| `jsonShape` | Recursive shape check. `{type: "string"}` descriptors match by type; nested objects recurse; arrays optionally check the first-element shape. |

Matchers accumulate — every failing matcher is reported in one go so you don't fix-and-rerun.

### Fixtures

The `fixture` field names a model the runner resolves. Out of the box:

- `residential-small` — 12 walls, 4 slabs, 6 doors, 8 windows, 5 spaces (IFC4)
- `office-medium` — 120 walls, 24 slabs, 48 columns, 96 beams (IFC4)
- `empty-model` — no entities

Custom fixtures can be wired by the host. From the CLI:

```bash
npx @ifc-lite/cli ext test ./my-bundle --bail
```

Exits non-zero on any failure; `--bail` stops on first fail.

## Forking an existing extension

In the Extensions panel, click the **Fork** icon on any installed extension row. The host seeds the chat with:

- The full manifest (in an `ifc-extension-manifest` fenced block)
- Up to 6 bundle files, each capped at 4 KB and fenced with `ifc-extension-code` / `ifc-extension-widget`
- A prompt asking what you want to change

The AI then runs the same authoring loop as a fresh bundle, modifying instead of creating. When you re-install, the Capability Review screen surfaces the diff vs your existing install (new / dropped capabilities are highlighted).

## The authoring loop

When the AI authors an extension, the pipeline is:

1. **Plan** — the LLM proposes an `AuthoringPlan` (summary, contributions, capabilities, triggers, tests). The user approves / edits via the Plan Card.
2. **Synthesize** — the LLM produces a fenced bundle (manifest + code + widgets).
3. **Validate** — the host parses each fenced block, runs the manifest validator, the widget validator, the code AST walker, and cross-references commands ↔ entry paths.
4. **Dry-run** — tests execute against the candidate bundle with tightened sandbox budgets (25% memory, 50% CPU of production).
5. **Repair** — if any step fails, structured diagnostics feed back as a user turn. Up to 4 attempts, 90 s per attempt, 6 min total.
6. **Install** — the resulting `.iflx` goes through the standard Capability Review screen before installing.

When the chat detects an authoring intent (you said something like "make a button that ...", "always color walls red"), it shows an **Authoring** chip in the header and attaches the full authoring contract (manifest schema + widget DSL + capability catalogue + style rules) to the system prompt. The contract is cached via Anthropic prompt caching, so subsequent authoring turns in the same session are cheap.

## Signing bundles (Phase 5 preview)

For shared / hosted distribution, bundles can be Ed25519-signed.

```bash
# Generate a keypair.
npx @ifc-lite/cli ext keygen --out ~/.config/ifclite/key

# Pack + sign in one shot.
npx @ifc-lite/cli ext pack ./my-bundle \
  --out my-bundle.iflx \
  --sign --key ~/.config/ifclite/key.private.iflk

# Verify against a known public key.
npx @ifc-lite/cli ext verify my-bundle.iflx --key ~/.config/ifclite/key.public.iflk
```

The signature commits to a canonical hash of the bundle contents + the `signedAt` timestamp (domain-separated to defeat substitution attacks). Verification recomputes the hash and runs `crypto.subtle.verify`. See the [signing & registry RFC](../architecture/ai-customization/10-registry-and-signing.md) for the full design.

## Troubleshooting

??? question "`ext validate` says 'banned global'"
    Your code references `globalThis`, `window`, `document`, or another disallowed name. The AST walker flags these at parse time. Remove the reference — the sandbox runtime would block the access anyway, this just surfaces it earlier.

??? question "Manifest fails with 'dangling command reference'"
    Cross-reference validator says a `toolbar` / `contextMenu` / `keybinding` contribution names a command that's not declared in `contributes.commands`. Add the command, or remove the reference.

??? question "Pack succeeds but install fails with 'entry script missing'"
    The manifest's `entry.commands["x"]` points at a file that isn't in the bundle. Likely you didn't `git add` the file before packing. Run `ext validate` first — it cross-references entries against the bundle's file map.

??? question "I want to inspect a packed `.iflx` without installing"
    `ext verify <file>.iflx` prints the manifest, file list, capability list, and signature (if any) without writing anything to the viewer's storage.

## Next steps

- [Extensions](extensions.md) — install and use extensions
- [Flavors](flavors.md) — bundle your extensions into a shareable profile
- [CLI reference](cli.md#ext--extension-toolkit) — every `ext` subcommand with flags
