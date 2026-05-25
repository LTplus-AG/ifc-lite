# 01 — Extension Model

This document specifies the extension contract: the manifest schema, the
lifecycle, the slot bindings, and the capability declarations. All
extensions — whether hand-authored or AI-generated — conform to the same
schema. The same schema is used by the host loader, the registry validator,
the test harness, and the AI authoring prompt.

## 1. Manifest schema (v1)

The manifest is the single source of truth for everything the host knows
about an extension. It is JSON, validated by a Zod schema that lives in a
new package `@ifc-lite/extensions` (see [§7](#7-package-layout)).

```ts
// Type sketch — authoritative definition in @ifc-lite/extensions/manifest.ts
interface ExtensionManifest {
  /** Manifest schema version. Bumps require a migration. */
  manifestVersion: 1;

  /** Stable identifier. Reverse-DNS recommended. */
  id: string;                        // e.g. "com.example.fire-rating-report"

  /** Human-readable name shown in UI. */
  name: string;                      // e.g. "Fire Rating Report"

  /** Free-form description. Plain text, no markup. */
  description: string;

  /** Semver. Drives update prompts and capability-diff detection. */
  version: string;                   // e.g. "1.2.0"

  /** Author info. Optional but required for registry publish. */
  author?: { name: string; url?: string; email?: string };

  /** SPDX license expression. Required for registry publish. */
  license?: string;                  // e.g. "MIT"

  /** SDK version compatibility range. Semver-style. */
  engines: { ifcLiteSdk: string };   // e.g. ">=2.4.0 <3.0.0"

  /**
   * Capabilities this extension requires.
   * See 02-security.md for the full grammar. Order is not significant.
   */
  capabilities: Capability[];

  /**
   * Activation events. The host loads + initializes the extension
   * only when one of these fires.
   */
  activation: ActivationEvent[];     // see §3

  /** UI slot bindings. See 03-ui-surface.md. */
  contributes?: {
    commands?: CommandContribution[];
    toolbar?: ToolbarContribution[];
    dock?: DockContribution[];
    contextMenu?: ContextMenuContribution[];
    keybindings?: KeybindingContribution[];
    lenses?: LensContribution[];
    exporters?: ExporterContribution[];
    idsValidators?: IdsValidatorContribution[];
    statusBar?: StatusBarContribution[];
  };

  /**
   * Code entry points. Each value is a path inside the extension bundle
   * to a JS module that exports the named function.
   */
  entry: {
    /** Called once on activation. Sets up state, registers handlers. */
    activate?: string;
    /** Called on deactivation / uninstall. Frees resources. */
    deactivate?: string;
    /** Map of command id → handler module path. */
    commands?: Record<string, string>;
    /** Map of trigger event → handler module path. */
    triggers?: Record<string, string>;
  };

  /**
   * Tests this extension ships with. Required for registry; optional
   * for local-only extensions. Each test runs the named handler against
   * a named fixture and asserts the result shape.
   */
  tests?: ExtensionTest[];

  /**
   * Localization. If present, all user-facing strings (name, description,
   * command titles) are looked up here keyed by locale.
   */
  l10n?: Record<string, Record<string, string>>;

  /** Optional Markdown shown in the install / details view. */
  readme?: string;
}
```

### 1.1 Why a single manifest

We considered a split manifest (one for permissions, one for UI, one for
code) modeled after VS Code's distinction between `package.json` and
`extension.ts`. Rejected because: (a) the AI authoring loop writes both
together and benefits from one schema to validate; (b) the registry
review screen needs to show capabilities and UI contributions side by
side; (c) merge conflicts in flavor bundles are easier with one document.

### 1.2 Schema validation

Validation lives in `@ifc-lite/extensions/manifest.ts` and is a Zod
schema. Failures produce structured errors (`{ path, code, hint }`) used
by:

- The loader (reject extension, show error in UI).
- The registry CI (reject publish).
- The AI repair loop (feed errors back to the model).
- The CLI `ifc-lite ext validate path/to/manifest.json` command.

### 1.3 Versioning and migration

`manifestVersion: 1` is the current revision. A future v2 ships with a
migration function in `@ifc-lite/extensions/migrations/v1-to-v2.ts`. The
loader will read any older version it has a migration for. Manifests
newer than the loader fail closed with a clear "update IFClite to use
this extension" error.

## 2. Bundle layout

An extension at rest is a directory (in IndexedDB or on disk):

```
my-extension/
├── manifest.json           Required. The schema above.
├── README.md               Optional. Shown on install / details page.
├── icon.svg                Optional. 24x24, monochrome, currentColor.
├── src/
│   ├── activate.js         Optional. Module exporting activate(ctx).
│   ├── commands/
│   │   └── export.js       Module exporting handler(ctx, args).
│   └── triggers/
│       └── on-model-load.js
├── tests/
│   ├── fixtures/
│   │   └── small.ifc       Or reference to manifest fixture by id.
│   └── export.test.json    Declarative test spec; see §6.
└── widgets/
    └── report-form.json    Declarative widget DSL; see 03-ui-surface.md.
```

The bundle is the unit of import / export / publish. Compressed it is a
single `.iflx` file (gzipped tar; the extension is `.iflx` because
`.ifcx` is taken by IFC5).

## 3. Activation events

Extensions are inert until an activation event fires. Activation defers
cost and limits attack surface — an extension that listens for a command
the user never invokes never executes its code.

| Event | Fires when |
|---|---|
| `onStartup` | App finishes initial boot. Use sparingly. |
| `onModelLoad` | Any model finishes loading. Receives the model id. |
| `onCommand:<id>` | The user invokes a named command. |
| `onLens:<id>` | A registered lens of this id is requested. |
| `onExporter:<id>` | A registered exporter of this id is invoked. |
| `onIdsValidator:<id>` | A registered IDS validator of this id runs. |
| `onSchema:<ifcVersion>` | A loaded model uses a given schema. |
| `onSlot:<slotId>` | The host renders a slot this extension contributes to. |

We deliberately omit a generic `onAlways` event. If you want it, you have
not understood your dependencies.

## 4. Capability declarations

Capabilities are scoped strings. Full grammar in
[`02-security.md`](./02-security.md). Examples:

```json
"capabilities": [
  "model.read",
  "model.mutate:Pset_*",
  "viewer.colorize",
  "viewer.isolate",
  "export.create",
  "storage.local",
  "network.fetch:bsdd.buildingsmart.org"
]
```

The principle: a reader of the manifest must be able to predict the
extension's blast radius from this list alone. If `network.fetch:*` is
needed, that is a flag the registry review screen highlights in red.

Capabilities are immutable for the life of an installed version.
Upgrading the extension to a new version that adds a capability triggers
an explicit re-consent flow ("This extension now wants to: fetch from
example.com. Approve?"). No silent capability growth.

## 5. Contribution points

Each contribution names a slot and provides slot-specific metadata. The
full slot catalogue is in [`03-ui-surface.md`](./03-ui-surface.md);
shape sketches here:

```ts
interface CommandContribution {
  id: string;                  // namespaced: "ext.<extId>.<cmd>"
  title: string;
  description?: string;
  icon?: string;               // lucide icon name
  paletteCategory?: string;    // groups in command palette
}

interface ToolbarContribution {
  command: string;             // refs a CommandContribution.id
  slot: 'toolbar.left' | 'toolbar.right' | 'toolbar.center';
  when?: WhenClause;           // visibility expression — see §5.1
  order?: number;              // tiebreak; lower = more leftward
}

interface DockContribution {
  id: string;
  slot: 'dock.left' | 'dock.right' | 'dock.bottom';
  title: string;
  icon?: string;
  widget: string;              // path to widgets/*.json
  when?: WhenClause;
}

interface ContextMenuContribution {
  command: string;
  slot: 'contextMenu.entity' | 'contextMenu.canvas' | 'contextMenu.tree';
  when?: WhenClause;
  group?: string;
}

interface KeybindingContribution {
  command: string;
  key: string;                 // e.g. "Ctrl+Alt+F"
  when?: WhenClause;
}

interface LensContribution {
  id: string;
  name: string;
  description?: string;
  /** Module path that exports an evaluate(provider) returning a Lens result. */
  evaluator: string;
}

interface ExporterContribution {
  id: string;
  name: string;
  mimeType: string;
  extension: string;           // e.g. ".csv"
  /** Module that exports run(ctx, store) returning Uint8Array | string. */
  handler: string;
}

interface IdsValidatorContribution {
  id: string;
  name: string;
  /** Module that exports validate(entity, store) returning IdsResult. */
  handler: string;
}
```

### 5.1 The `when` clause

Borrowed from VS Code. A small expression language over a fixed set of
context keys: `model.loaded`, `model.schema`, `selection.count`,
`selection.type`, `viewer.open`, `desktop`, `embed`. Example:

```
"when": "model.loaded && selection.count > 0 && selection.type == 'IfcWall'"
```

The expression is parsed by the host (not the extension) and evaluated
each frame as state changes. Extensions never see the underlying state;
they only see the boolean result via the slot's visibility.

## 6. Tests as deliverables

Every contribution that produces an output (exporters, validators,
lens evaluators, commands with a structured result) ships at least one
test. The test spec is declarative:

```json
{
  "name": "export produces non-empty CSV for the residential fixture",
  "command": "ext.com.example.fire.export",
  "fixture": "residential-small",
  "args": { "groupBy": "storey" },
  "expect": {
    "mimeType": "text/csv",
    "minBytes": 200,
    "regex": "^GlobalId,Name,FireRating"
  }
}
```

The test runner lives in `@ifc-lite/extensions/test-runner.ts`:

- Loads the named fixture (from `tests/models/manifest.json`).
- Spins up a QuickJS sandbox with the extension's capabilities.
- Runs the command / contribution.
- Validates output shape against `expect`.

Tests run:

- On extension install (one-time gate).
- On SDK upgrade (CI for the host; also runs locally on user devices
  when the SDK version moves).
- On extension upgrade.
- On demand via `ifc-lite ext test <id>`.

If tests fail on an SDK upgrade, the repair loop is invoked
automatically ([§04-ai-authoring.md](./04-ai-authoring.md)).

## 7. Package layout

Two new packages, both small:

### `@ifc-lite/extensions`

The host-side runtime. Exports:

- `ExtensionManifest` Zod schema and TypeScript types.
- `ExtensionLoader` — loads bundles from IndexedDB or disk, validates,
  registers contributions.
- `ExtensionHost` — coordinates lifecycle, dispatches activation events,
  enforces capability grants.
- `SlotRegistry` — the host's catalogue of contribution points; UI
  components subscribe by slot id.
- Test runner.
- Manifest migration helpers.

Dependencies: `zod`, `@ifc-lite/sandbox`, `@ifc-lite/sdk`. No new
heavy deps.

### `@ifc-lite/extensions-cli`

CLI helpers (`ifc-lite ext init|validate|test|pack|publish`). Lives
alongside `@ifc-lite/cli` so the unified CLI surface remains.

The viewer app imports `@ifc-lite/extensions` and renders slot
subscribers in its existing layout. No new app package; this is a
feature added to the viewer, not a new product.

## 8. Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│  app start                                                      │
│      │                                                          │
│      ▼                                                          │
│  ExtensionLoader scans IndexedDB                                │
│      │                                                          │
│      ▼                                                          │
│  validate manifest (reject on error)                            │
│      │                                                          │
│      ▼                                                          │
│  check capability grants (UI prompt if any missing)             │
│      │                                                          │
│      ▼                                                          │
│  check SDK version range; reject or repair on mismatch          │
│      │                                                          │
│      ▼                                                          │
│  register slot contributions (UI now sees them)                 │
│      │                                                          │
│      ▼                                                          │
│  wait for activation events                                     │
│      │                                                          │
│      ▼  (activation event fires)                                │
│  ExtensionHost.activate(id)                                     │
│      ├─ create QuickJS context with scoped bridge                │
│      ├─ call entry.activate(ctx)                                 │
│      └─ retain ctx until deactivate or uninstall                 │
└─────────────────────────────────────────────────────────────────┘
```

A deactivated extension still has its contributions registered; they
just route through a re-activation path on next use. Uninstall removes
everything including capability grants.

## 9. The `ctx` object

Every entry function receives a `ctx`. This is the only authority the
extension holds. There is no `globalThis.fetch`, no `window`, no
`require('fs')`. The `ctx` is the OCAP capability bundle.

```ts
interface ExtensionContext {
  /** The bim SDK, scoped to granted model.* capabilities. */
  bim: BimContext;

  /** Logger; lines visible in the extension console panel. */
  log: { info(...): void; warn(...): void; error(...): void };

  /** Local key-value storage scoped to this extension. */
  storage: { get(k): Promise<unknown>; set(k, v): Promise<void>; del(k): Promise<void> };

  /** Fetch capability — present only if network.fetch:* was granted. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;

  /** Notification capability — toast / status bar messages. */
  notify: (level: 'info' | 'warn' | 'error', message: string) => void;

  /** Register a teardown handler. Called on deactivate. */
  onDispose: (handler: () => void | Promise<void>) => void;

  /** Locale resolver — looks up against manifest.l10n. */
  t: (key: string, vars?: Record<string, string>) => string;

  /** Metadata about the host, SDK version, current models. */
  meta: ExtensionMeta;
}
```

If the bridge layer hands an extension an authority it did not declare
in its manifest, that is a security bug in the host. The bridge tests
assert grant ↔ ctx-field equivalence for every capability.

## 10. Open questions

1. **Concurrent extension limits.** Should the host cap the number of
   active extensions? VS Code does not; Figma does. We propose no cap in
   v1 but instrument concurrent active extension count for later policy.
2. **Inter-extension communication.** Can extension A call extension B's
   command? Proposed: yes via `ctx.commands.invoke('<id>', args)`, but
   the host enforces capability intersection (B's capabilities must be a
   superset of what A's invocation needs).
3. **Bundle integrity.** Should the bundle include a content hash in
   the manifest, signed by the author? Proposed: required for registry
   publish, optional for local. See [`02-security.md`](./02-security.md).
4. **Native UI escape hatch.** Will we ever need an iframe escape hatch
   for extensions that genuinely need DOM (rich text editors, custom
   canvases)? Proposed: not in v1. Re-evaluate at Phase 3 with concrete
   use cases.
