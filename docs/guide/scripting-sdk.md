# Scripting SDK

The `@ifc-lite/sdk` package is the scriptable BIM API behind `ifc-lite eval`, `ifc-lite run`, the viewer's script console, and the extension system. Everything hangs off a single `bim` object: query entities, read properties and quantities, walk the spatial tree, edit properties, run clashes, and export, all through one typed surface.

## The `bim` API surface

The `bim` object (a `BimContext`) groups its capabilities into namespaces, plus a set of top-level helpers for the common query paths. The main namespaces:

| Namespace | Purpose |
|-----------|---------|
| `bim.model` | Loaded-model management (list, active model) |
| `bim.query()` | Start a fluent entity query chain |
| `bim.viewer` | Colorize, isolate, hide/show, section, fly-to (drives a running viewer) |
| `bim.mutate` | Property and attribute edits |
| `bim.store` | Document-level edits (add/remove entities, positional attributes) |
| `bim.lens` | Lens visualization presets |
| `bim.create` | Create IFC elements from scratch |
| `bim.export` | Export to CSV, glTF, STEP, HBJSON, and more |
| `bim.clash` | Run clash rules and the discipline matrix |
| `bim.ids` | IDS validation |
| `bim.bcf` | BCF topics, comments, viewpoints |
| `bim.files`, `bim.schedule`, `bim.spatial`, `bim.spaces`, `bim.drawing`, `bim.list`, `bim.bsdd`, `bim.events`, `bim.sandbox` | Supporting namespaces (file access, scheduling, spatial ops, space program, 2D drawings, entity tables, bSDD lookups, events, sandboxed sub-scripts) |

On top of the namespaces, `BimContext` exposes direct helpers for the hot paths, so you rarely reach into internals: `bim.query()`, `bim.entity(ref)`, `bim.properties(ref)`, `bim.quantities(ref)`, `bim.materials(ref)`, `bim.classifications(ref)`, `bim.storeys()`, `bim.contains(ref)`, `bim.containedIn(ref)`, `bim.storey(ref)`, `bim.path(ref)`, and more.

```js
// Fluent query
const externalWalls = bim.query()
  .byType('IfcWall')
  .where('Pset_WallCommon', 'IsExternal', '=', true)
  .toArray();

// Direct helpers
const storeys = bim.storeys();
for (const s of storeys) {
  console.log(`${s.name}: ${bim.contains(s.ref).length} elements`);
}
```

## Running scripts from the CLI

### `eval` — one-liners

`ifc-lite eval` evaluates a single JavaScript expression with `bim` in scope:

```bash
# Count walls
ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"

# List storey names
ifc-lite eval model.ifc "bim.storeys().map(s => s.name)"

# Per-entity evaluation: --type binds `ref` and `entity` to each match
ifc-lite eval model.ifc "bim.quantity(ref, 'GrossSideArea')" --type IfcWall --limit 3
```

With `--type`, the expression runs once per matching entity with `ref` (the entity reference) and `entity` in scope; without it, the expression runs once with `bim`. Add `--json` for machine-readable output.

### `run` — script files

`ifc-lite run` executes a `.js` file with `bim` and `console` available:

```bash
ifc-lite run analysis.js model.ifc

# Stream bim.viewer.* calls to a running `ifc-lite view` instance
ifc-lite run paint.js model.ifc --viewer 3456
```

```js title="analysis.js"
const walls = bim.query().byType('IfcWall').toArray();
console.log(`Found ${walls.length} walls`);

for (const wall of walls) {
  const psets = bim.properties(wall.ref);
  const common = psets.find(p => p.name === 'Pset_WallCommon');
  const isExternal = common?.properties.find(p => p.name === 'IsExternal');
  console.log(`  ${wall.name}: external=${isExternal?.value ?? 'unknown'}`);
}
```

!!! warning "`eval` and `run` are not sandboxed"
    The CLI `eval` and `run` commands execute your code directly in the Node
    host (via `new Function`), with full access to the machine. They are meant
    for **your own** scripts and trusted LLM-generated snippets on your own
    files. To run **untrusted** code, use the sandbox below. Pointing `--viewer`
    at a running viewer streams `bim.viewer.*` calls to it in real time.

## Discovering the API for LLM tooling

`ifc-lite schema` dumps the scriptable API as JSON so an LLM (or you) can discover methods before writing code:

```bash
ifc-lite schema              # full schema with params and return types
ifc-lite schema --compact    # names and descriptions only
```

The schema covers the scriptable namespaces, `model`, `query`, `viewer`, `mutate`, `store`, `lens`, `create`, `files`, `schedule`, `clash`, and `export`, and includes each method's parameter names, return type, and LLM semantic hints (`useWhen`, task tags). Running `ifc-lite schema` first is the recommended way to author correct `eval`/`run` code. See [Using with LLM Terminals](cli.md#using-with-llm-terminals) for the wider agent workflow.

## The sandbox

`@ifc-lite/sandbox` runs scripts in an isolated **QuickJS-in-WASM** interpreter, the mechanism the viewer and the [extension system](extensions.md) use to run untrusted code safely. Each sandbox gets a fresh QuickJS context; the `bim` API is rebuilt inside it, gated by permissions; and TypeScript is transpiled to JavaScript before execution.

```ts
import { Sandbox } from '@ifc-lite/sandbox';

const sandbox = new Sandbox(bim, {
  permissions: { query: true, mutate: false }, // read-only by default
  limits: { memoryBytes: 64 * 1024 * 1024, timeoutMs: 30_000 },
});
await sandbox.init();
const result = await sandbox.eval(`bim.query.create().byType('IfcWall').count()`);
console.log(result.value, result.logs, result.durationMs);
```

Or reach it through the SDK as `bim.sandbox.eval(script, config)`, which returns the same `ScriptResult` (`value`, captured `logs`, `durationMs`).

**Permissions** gate which namespaces the script can touch (`model`, `query`, `viewer`, `mutate`, `store`, `lens`, `export`, `files`). The defaults are read-only: `mutate` and `store` are off, everything else on. **Limits** cap resources, defaulting to 64 MB heap, a 30-second timeout, and a 512 KB stack. A namespace whose permission is disabled is simply not built on the sandboxed `bim` handle, so a script cannot call what it was not granted.

### Sandboxed vs. direct

| Path | Runtime | Isolation |
|------|---------|-----------|
| `ifc-lite eval` / `ifc-lite run` | Node host, `new Function` | None, full host access |
| `bim.sandbox.eval` / `@ifc-lite/sandbox` | QuickJS-in-WASM | Permissions + memory/CPU/stack limits |
| [Extensions](extensions.md) | QuickJS-in-WASM | Capability-gated bundle sandbox |

Use the direct path for your own scripts; use the sandbox when the code comes from somewhere you do not fully trust.

## Embedding programmatically

Create a `BimContext` yourself with `createBimContext`. It needs either a local `backend` (viewer-embedded) or a `transport` (connected to a running viewer):

```ts
import { createBimContext } from '@ifc-lite/sdk';

// Local mode: drive an in-process backend
const bim = createBimContext({ backend: myLocalBackend });
const wallCount = bim.query().byType('IfcWall').count();

// Remote mode: talk to a running viewer over a transport
const remote = createBimContext({ transport: myBroadcastTransport });
remote.viewer.colorize(refs, '#ff0000');
```

In remote mode `bim.viewer.*` calls are forwarded to the connected viewer, which is exactly how `ifc-lite run script.js model.ifc --viewer <port>` works under the hood. For the full type surface, see the [`@ifc-lite/sdk` README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/sdk) and the [TypeScript API reference](../api/typescript.md).
