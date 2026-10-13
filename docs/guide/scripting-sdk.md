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
| `bim.export` | Export to CSV, JSON, IFC/STEP, HBJSON, DFJSON |
| `bim.clash` | Run clash rules and the discipline matrix |
| `bim.cost` | Read and evaluate IFC 5D cost schedules, items, values, and quantities |
| `bim.structural` | Read-only access to IFC structural analysis data (analysis models, members, connections, activities, load/result groups) |
| `bim.ids` | IDS validation; `bim.ids.authoring` opens, edits (through grounded operations), lints and writes IDS documents |
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

### Authoring IDS from a script

`bim.ids.authoring` edits IDS documents with the typed operations and
grounding gate that the IDS editor and the MCP `ids_apply_ops` tool use (see
[Writing IDS documents](ids.md#writing-ids-documents)). A batch that names an entity, property
set or property the IFC schema does not have is refused as a whole. The
result lists each problem with ranked candidates. Accepted batches can be
undone.

```ts
declare const xml: string;
const doc = await bim.ids.authoring.open(xml);
const specId = doc.doc.nodes.specs[0].id;

const res = doc.apply([
  {
    kind: 'facet.add',
    opId: crypto.randomUUID(),
    payload: {
      specId,
      section: 'requirements',
      facetId: crypto.randomUUID(),
      facet: {
        type: 'property',
        propertySet: { kind: 'equals', value: 'Pset_DoorCommon' },
        baseName: { kind: 'equals', value: 'FireRatng' },
      },
    },
  },
]);
if (!res.ok) console.log(res.errors[0].code, res.errors[0].candidates[0]?.value); // GATE-PROP-001 FireRating

for (const d of doc.lint()) console.log(d.code, doc.pathOf(d.nodeId), d.message);
const updated: string = doc.write(); // throws, with the reason, if the writer refuses the document
```

## Explicit property declarations

The SDK's `bim.mutate.setProperty(ref, psetName, propName, value, dataType?)` accepts an optional IFC `IfcValue` defined type. Use the EXPRESS name, for example `IfcThermalTransmittanceMeasure` or `IfcLabel`. The shared schema registry validates membership, scalar value compatibility, declared numeric domains, and string width before writing. Invalid or unknown declarations throw; an integer JavaScript value can still declare a real-valued IFC measure.

```js
const wall = bim.query().byType('IfcWall').toArray()[0];
if (wall) {
  bim.mutate.setProperty(wall.ref, 'Pset_WallCommon', 'ThermalTransmittance', 1, 'IfcThermalTransmittanceMeasure');
}
```

The declaration survives the effective property overlay, collaboration mirror/peer application, and IFC export/reimport. Without `dataType`, the existing string/boolean/integer/real inference remains unchanged. This optional argument belongs to the direct SDK and CLI `eval`/`run` API; the sandbox script bridge retains its existing four-argument contract.

## Native Review normalization

`@ifc-lite/sdk/review` contains the pure finding and coordination-card
normalization used by the viewer. Hosts supply their actual native reports and
model lookup functions; these helpers do not run an analysis, edit a model,
create an artifact or make a human decision. Validation statuses and BCF topic
statuses remain native facts. A historical resolution candidate remains a
candidate.

`clashFindings` preserves native clash statuses and revision coverage: stale or
truncated runs cannot establish that a historical clash disappeared.
`clashGlobalId` separates the IFC GlobalId from an occurrence suffix, while
`clashOccurrenceKey` retains both model-qualified occurrences. Discipline
candidates from `clashDisciplineCandidates` are hints, not responsibility
assignments. `savedValidationFacts` projects actual saved IDS failure rows;
saved evidence remains historical and incomplete, and callers supply any
current re-examination outcomes. These helpers share the viewer's existing
behavior and do not verify portable source identity.

```ts
import { snapshotFrom, validationFindings, type ReviewModel } from '@ifc-lite/sdk/review';
import type { ValidationReport } from '@ifc-lite/ids';

function nativeValidationReview(report: ValidationReport, models: readonly ReviewModel[], stale: boolean) {
  return snapshotFrom([{ kind: 'validation', collect: currentModels =>
    validationFindings({ report, stale }, currentModels) }], models);
}
```

A native validation run that evaluates fewer applicable elements than it
found carries an explicit incomplete/truncated gap. Omitting passing detail
rows from an otherwise fully evaluated run does not imply incomplete coverage.
A failed collector contributes an explicit `failed` entry. Missing native
inputs are not a completed clean analysis; the host must report their source
availability separately. Existing viewer card keys use a model name and IFC
GlobalId and refuse ambiguous loaded owners. Those display/navigation keys
are not proof of source-byte identity or portable captured-run provenance.

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

`ifc-lite schema` documents the `bim` object `eval`/`run` actually hand your script — a root `bim` namespace of top-level methods, plus the scriptable namespaces `model`, `query`, `viewer`, `mutate`, `store`, `lens`, `create`, `files`, `schedule`, `cost`, `clash`, and `export` — and includes each method's parameter names, return type, and LLM semantic hints (`useWhen`, task tags). There `query` is the chain reached via `bim.query()` (`.byType(...).toArray()`), not a namespace of standalone lookups. That differs from the sandbox's own bridge schema shown below, where `bim.query.byType(...)` runs and returns data in one call — the sandbox and `eval`/`run` hand scripts different `bim` shapes, so pick the one matching where the script will run. Running `ifc-lite schema` first is the recommended way to author correct `eval`/`run` code. See [Using with LLM Terminals](cli.md#using-with-llm-terminals) for the wider agent workflow.

### IFC 5D cost data

`bim.cost` reads the canonical cost graph from the loaded IFC source snapshot.
References are model-qualified and evaluated amounts remain decimal strings:

The example below uses the canonical fixture at
`tests/models/cost/buildingsmart-cost-composition.ifc` (fetch it with
`pnpm fixtures`), which contains the `External wall total` item.

```js
const graph = bim.cost.data();
const total = graph.CostItems.find(item => item.Name === 'External wall total');
const result = bim.cost.evaluateItem(total.ref, { Precision: 34 });
console.log(result.Amount, result.Currency, result.Diagnostics);
```

`CostValues`, `CostQuantities`, relationships, and diagnostic references all
use `{ modelId, expressId }`. Generic mutation overlays are not folded into
this read model; replacing or reloading the IFC source refreshes it.

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

**When `eval()` throws.** It rejects with a `ScriptError` (carrying `message`, `logs` and `durationMs`) for a throw in the script's main body, for a CPU timeout, and — since the fix in #2078 — for a script whose entry point is `async` and whose returned promise **rejects** after its first `await`. That last case previously *resolved*: the main body had succeeded, so the rejection came back as ordinary data in `result.value` (`{ type: 'rejected', error: … }`) and a failed script looked like a clean pass. If you upgrade across that change and were relying on `eval()` resolving, you will start seeing the error propagate.

One case is still **not** reported: a rejection in a promise the script never hands back — `run(); 'started'` rather than `return run()`. There is no handle to inspect, and quickjs-emscripten exposes no host rejection tracker, so nothing observes it.

**When `dispose()` throws.** The same unawaited shape has a second failure mode: if that detached job exhausts the memory limit, it leaves objects orphaned on QuickJS's GC list and upstream `JS_FreeRuntime` asserts, so teardown comes back as an emscripten abort — a `SandboxAbortError` from `dispose()` ([#1922](https://github.com/LTplus-AG/ifc-lite/issues/1922)). The `eval()` that caused it resolved normally, so **teardown is the only place that run's failure is observable**: settle a run's outcome *after* disposing it, not before, or you will report a clean result for a script that died.

The abort poisons the whole WASM module, not just the one sandbox. The package retires it and builds the next sandbox on a fresh instance — a few milliseconds, no page reload, and nothing to do for the common case where a sandbox is created per run.

A host that keeps **one sandbox alive across many runs** — an extension runtime, a REPL — does have something to do. Its sandbox may be sitting on a module that some *other* sandbox's abort retired. It still executes scripts, but emscripten's abort latch is per module and has already fired on it, so its own teardown can no longer report a failure and it will silently leak. `Sandbox.moduleRetired` is that signal; the contract is to discard, not to reuse:

```ts
import { createSandbox, type Sandbox, type SandboxConfig } from '@ifc-lite/sandbox';

async function ensureLiveSandbox(sandbox: Sandbox, config: SandboxConfig): Promise<Sandbox> {
  if (!sandbox.moduleRetired) return sandbox;
  sandbox.dispose();
  return createSandbox(bim, config); // fresh module, no page reload
}
```

Check it while the sandbox is live: `dispose()` releases the module reference, after which `moduleRetired` reads `false`. The process-wide `isSandboxRuntimeAborted()` is a diagnostic — latched for the process lifetime — not a health check; a `true` does not mean scripting is dead.

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

### Exporting the whole model vs. a subset

`bim.export.ifc(refs, options)` reads its first argument as an isolation filter,
and the *absence* of that argument is what asks for the whole model:

```ts
bim.export.ifc();                                   // no filter: the whole model
bim.export.ifc(bim.query().byType('IfcWall').refs()); // only the walls (plus their reference closure)
```

An **empty array is not the same as no argument**. It means a filter that
matched nothing, and it is refused:

```ts
const refs = bim.query().byType('IfcNonExistentType').refs(); // []
bim.export.ifc(refs); // throws: the isolation filter matched nothing
```

An empty array used to mean "no filter", so a query that matched nothing
silently exported every entity in the model and reported success. The release
that changed this is the `@ifc-lite/sdk` major carrying issue #4738 in its
changelog; before it, the refusal above did not happen. A call that used the
empty array to mean the whole model, `bim.export.ifc([], options)`, becomes
`bim.export.ifc(undefined, options)`.

The same distinction holds in a sandboxed script (`bim.export.ifc()` with no
arguments) and behind the CLI's `--format ifc`, which refuses a zero-match
`--type`/`--where`/`--storey`/`--limit` rather than exporting everything.

### Textured IFC exports in the web viewer

The viewer's `bim.export.ifc(refs, options)` returns IFCZIP `Uint8Array` bytes
when retained texture images accompany the exported model or subset. Its existing
return type remains `string | Uint8Array`; do not decode archive bytes as STEP
text. Supplying an `.ifc` download filename automatically changes it to
`.ifczip` with ZIP MIME type. Untextured exports retain their ordinary STEP
content. This packaging belongs to the web viewer adapter; other SDK backends
provide their own resource packaging.

### Canonical structural profiles

Sandbox `bim.store.addColumn`, `addBeam` and `addMember` accept the same
parameterized `Profile` union as the typed SDK. A supplied `Profile` replaces
the rectangular Width/Depth or Width/Height inputs; column Height and element
placement remain required. Profile dimensions keep their IFC names and use
metres. The shared builder validates the actual profile before committing.
Ordinary creation through the viewer SDK records the complete authored graph,
so one Undo removes auxiliary placement, profile and containment records too.

### Align loaded elements

`await bim.store.alignElements(modelId, reference, targets, mode)` aligns current
native mesh edges or centres in one storey workplane. Modes are `left`, `centre`,
`right`, `top`, `middle` and `bottom`. It derives bounds from fresh owning-model
geometry and records one atomic Undo batch. A selected host governs its placement dependants, which move once, and
joined neighbours follow. Stale geometry, unavailable native geometry, unsafe
shared placements, incompatible hosted/joined shifts, or a reference that would
move with a target refuse without partial IFC writes. Supply the owning model
ID when federated; lengths are IFC storey-local metres.

### Generic groups

`bim.store.addGroup`, `readGroup`, `updateGroup`, and `removeGroup` author exact
`IfcGroup` records in IFC4/IFC4X3. Each member pins its owning `modelId`, native
`expressId`, and current `GlobalId`. Pass the complete intended `RelatedObjects`
list on every create/update; an explicit `[]` clears membership. An update or
delete also requires the complete current snapshot returned by `readGroup`.

```ts
import type { BimContext, GroupStoreIdentity } from '@ifc-lite/sdk';

function createInspectionGroup(bim: BimContext, member: GroupStoreIdentity) {
  const group = bim.store.addGroup(member.modelId, {
    Name: 'Inspection group', RelatedObjects: [member],
  });
  const expected = bim.store.readGroup(group);
  bim.store.updateGroup(expected, {
    Description: 'Ready for inspection', RelatedObjects: [member],
  });
  return group;
}
```

Updates preserve the group and reuse an existing exact membership relationship.
Deleting a group preserves its member objects and other group memberships;
shared incoming memberships are rewritten safely. Other incoming dependencies,
ambiguous/deleted identities, specialized assignment semantics, and exceeded
graph budgets refuse the whole edit. The viewer records one native Undo batch.
Replacement refuses typed `RelatedObjectsType` assignments and consolidation
of assignments with distinct OwnerHistory, Name or Description. Their separate
semantics cannot be represented by this complete-member-list update; reading
and safe deletion remain supported.
Specialized Structural groups retain their separate authoring methods.

## Native Review capture lifecycle

The Review leaf's `NativeReviewCaptures` and `readNativeReview` serve actual
native hosts. A host supplies `NativeReviewModel` handles with the real source,
owner/store identity, read-only GlobalId lookups and current overlay revision.
`begin` captures source and definition proof before evaluation; `finish` retains
the native report; `readNativeReview` produces the common bounded native host read.
Captures with unavailable proof refuse explicitly, and partial overlays cannot
confirm complete effective-state coverage. These live captures are distinct
from portable saved facts; see the lifecycle contract below.

Capture start and projection take a callback that enumerates the current host-owned models and a live permission predicate. They revalidate every captured owner, store, source, mutation view and monotonic revision after all awaited hashes. The bounded projection runs synchronously inside that final check. `presentationComplete` describes response clipping; `nativeCoverageComplete` describes the retained native runs, including their freshness and evaluation coverage.

A native host that resolves Flow credentials calls `enrollCredentials` with only
its already authorized values before execution. Credentials remain in bounded
owner-local memory; `begin`, `finish` and `read` refuse sensitive capture/envelope
content. `acceptsEvidence` also guards the final card projection's current display
metadata. Exceeding the credential bound fails the owner closed without dropping
previously known values. Concurrent `begin` calls reserve pending capacity before proof work and recheck ownership and permission synchronously after hashing.

Successful reruns replace the same producer/definition/full-source ownership context only after settlement. Relative ordering follows operation initiation, before proof hashing; older asynchronous completion cannot replace newer success or clear a newer refusal. Producer failure or cancellation releases its pending reservation. A proven newer failed attempt keeps earlier matching facts under their original run ID and completion time as historical, incomplete evidence, including when the older proof completes after the newer failure. If that failure proof is replaced by a later operation before an older pending proof can establish exact context equality, the older capture is conservatively omitted as `capture-bound`, with unknown historical coverage instead of a guessed match. `latestAttempt` reports the latest operation outcome and its proof when available; failure before proof does not invent a matching definition or source identity. A later genuine operation can recover transient refusal.

Distinct contexts use bounded oldest-settled retention. Eviction sets `retention.inventoryOmitted`; omitted historical run counts remain unknown. `bounds.knownFindingsScope` is `retained-current-contexts`, so retained row counts never claim a complete historical inventory. If an older proof-pending operation outlives eviction of potentially newer context evidence, its later capture is conservatively refused as `capture-bound`; its independent native report remains intact. This uncertainty uses only a flag on the bounded pending record; `retention.captureRefusal` discloses the resulting `capture-bound` omission without relabelling a newer successful operation. Reads do not change retention or analysis state. If a retained context is replaced or evicted while a read awaits its source proof, that read returns `capture-bound` unavailability rather than claiming older rows as current; a later read can project the newer facts.

Native Review bounds separate `presentationComplete` (all retained rows and text fit the response limits) from `nativeCoverageComplete` (the retained native runs are complete and fresh, with no omitted capture inventory). A complete presentation can still describe a stale or partially evaluated run. Both checks use current model ownership and permissions after source hashing; access revoked during that await suppresses the entire captured target envelope.


Hosts must call `abandon(token)` when native evaluation throws, and use `abandon(token, "aborted")` on cancellation before rethrowing the original failure. `begin` releases refused proof reservations itself. Successful completion calls `finish(token, report)` exactly once. Credential overflow remains a permanent owner-local security refusal; ordinary source, ownership, permission, producer, or capacity failure does not disable later genuine capture attempts.

Native Review `modelIds` selects whole captured target sets independently of current authorization. A wholly permitted capture outside the request is omitted; a capture spanning requested and excluded models is refused as a whole. Permission revocation remains fail-closed after source hashing. Hash reuse follows the actual source object, including models that share a host owner. An older delayed proof cannot revive a newer same-context capture after retention eviction.

Native capture admission and portable reads share the existing text budget: object-property names and string values both count toward 1,048,576 UTF-16 code units, with a 16,384 UTF-16 code-unit limit per key or value. A report that exceeds it is refused as `capture-bound` at native `finish`; the independent analysis report is retained by its producer, and the Review capture records unknown inventory rather than silently truncating it.

### Portable report contracts

The Review entry point shares the viewer's existing `SavedAnalysisRun` and
`SavedValidationReport` contracts. Use `decodeSavedAnalysisRun` or
`validateSavedReport` to validate an imported payload; use
`bindSavedAnalysisModels` with actual source, edit, and placement evidence to
bind a saved analysis scope. Full-content source hashes remain distinct from
legacy sampled fingerprints. A valid payload remains historical evidence:
validation does not make its execution attested, its freshness current, or its
manual answers the result of a native evaluation. The codecs perform no save
or model mutation.


For supplied history, pass `createNativeReviewIdentityTable(store)` with each
`NativeReviewModel` and call
`readPortableReview(captures, liveModels, request, allowed)`. The request accepts
`savedAnalysisRuns` and `savedValidationReports`. The reader verifies full source
SHA-256 and duplicate-checked identity columns under current owner, revision and
permission leases. Legacy or ambiguous evidence remains explicitly unbound.
`records` retains original bounded native facts; `bindings` describes identity
proof separately. Imported findings stay historical and not evaluated, with
incomplete native coverage. No analysis, editor, persistence or scene mutation
is performed.

Portable `bounds` describe the supplied finding inventory, while cards and totals describe only the visible rows. A zero row limit retains the original records and reports hidden findings. Saved omissions, source gaps, truncated clash/IDS evaluation, or missing failed detail keep complete inventory and omission counts unknown and `presentationComplete` false; imported evidence never establishes complete native coverage.
Non-IDS saved report kinds retain their original records but expose `unsupported-kind` binding and no projected findings; a matching model source alone does not certify manual element identity or evaluation.
