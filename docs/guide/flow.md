# Flow Graphs

A flow graph is a node-based program over a BIM model: query elements, read
and restructure their data, write properties back, highlight results in the
viewer, and export tables. The same `*.flow.json` runs in the browser and
with `ifc-lite flow run` in CI, and every write lands in the model's change
set, so it is previewed, undone, and published like any other edit.

The runtime is `@ifc-lite/flow`; the standard nodes are `@ifc-lite/flow-nodes`.

## One data model

Every value travelling along an edge has one of three structures:

| Structure | What it is | Typical source |
|---|---|---|
| **Item** | one value | a number, a selected entity, a table |
| **List** | ordered values | the walls a selector matched |
| **Group** | lists keyed by string | openings *per wall*, walls *per storey*, sheets *per name* |

A group has exactly one keyed level. That single rule replaces Grasshopper's
data trees (paths, Path Mapper, Simplify) and Dynamo's list levels: BIM data
is keyed — by GlobalId, storey, sheet name, grid intersection — so the key
*is* the structure.

Entities are handles (`{ globalId, modelId?, expressId? }`), never copies of
their data. A node reads what it needs through the SDK when it runs.

Tables carry typed columns: each column records the IFC value type
(`real`, `integer`, `label`, `boolean`, …), an optional unit, and, for
property columns, the `pset`/`prop` it was read from. A table always names
its key column, so a sheet edited in Excel can be matched back to entities
without guessing.

## How nodes iterate

A port declares the **access** it wants: `item`, `list`, or `group`. The
runtime adapts the incoming structure to it:

- An `item` port receiving a list is **laced**: `shortest` (default),
  `longest` (repeat the last value), or `cross` (every combination, keyed
  `i|j`; refused above a size guard).
- An `item` or `list` port receiving a group runs **once per branch**.
  Two group inputs match **by key**, never by position; a key present on
  one input and missing on the other is reported and that branch is
  skipped.
- A `group` port receives the whole group; a plain list arrives as the
  single branch `""`.

Lanes are keyed by the driving entity's GlobalId when there is one, so a
lane's identity survives reordering or insertion of elements. When a node
has to fall back to index keys the run log says so.

A `null` reaching a non-nullable `item` port short-circuits that lane: the
node is not called and its outputs for that lane are `null`. Errors inside
one lane are logged with the lane key and yield `null`; the run continues.

Restructuring is a small, complete set of nodes: `core.groupBy`,
`core.flatten`, `core.keys`, `core.lookup`, `core.first`, `core.item`,
`core.wrap`, `core.filter`, and for tables `table.groupRows` and
`table.pivot`.

## The document

```json
{
  "flowVersion": 1,
  "id": "fire-rating-audit",
  "name": "Fire rating audit",
  "capabilities": ["model.read", "viewer.colorize", "model.mutate:Pset_WallCommon"],
  "inputs": [{ "nodeId": "rating", "param": "value", "label": "Default fire rating", "kind": "scalar" }],
  "outputs": [{ "nodeId": "missingCount", "port": "count", "label": "Walls without FireRating" }],
  "nodes": [
    { "id": "walls", "type": "model.select", "params": { "selector": "IfcWall" } },
    { "id": "fr", "type": "model.property", "params": { "pset": "Pset_WallCommon", "property": "FireRating" } }
  ],
  "edges": [{ "from": ["walls", "entities"], "to": ["fr", "entity"] }]
}
```

- `capabilities` use the [extension grammar](extension-authoring.md#capabilities). The
  viewer gates every node against the grants the user accepted; a write node checks the
  *actual* pset it is about to touch, so `model.mutate:Pset_WallCommon` does not let it
  write `Pset_DoorCommon`.
- `inputs` mark node params a Player form (or `--input` on the CLI) sets; `outputs` mark the
  ports shown as results. `ifc-lite flow describe` prints both.
- `lacing`, `tracking` and `trackingKey` are per node. Positions (`pos`) live in the file;
  tracked element sets do not.

The full document is `apps/viewer/src/lib/flow/examples/05-fire-rating-audit.flow.json` — the panel’s example 5, which the CLI test runs end to end.

## Spreadsheet connectors

`table.readCsv` / `table.writeCsv` and `table.readXlsx` / `table.writeXlsx`
move a `Table` to and from a mapping spreadsheet:

- `table.readCsv` takes CSV text on its `text` input, `columns` (`[{ name, type }]`,
  defaulting to the header row typed `string`) and `delimiter` params, and returns
  `table` plus `problems` — a malformed row (wrong field count, a cell that will not
  parse as its column's type) is **reported, never dropped**.
- `table.writeCsv` is the reverse, through `@ifc-lite/export`'s `tableToCsv` — the one
  place in the repo that guards a cell against spreadsheet formula injection
  (CWE-1236; `scripts/check-csv-escaper-copies.mjs` fails the build on a second copy).
- `table.readXlsx` / `table.writeXlsx` do the same over a single-sheet `.xlsx`
  workbook. A `Scalar` carries no bytes, so the workbook travels an edge as base64
  text (`data` in/out). The underlying `readXlsxTable`/`writeXlsxTable` functions are
  exported from `@ifc-lite/flow-nodes` as a shared module — both the CLI and the
  viewer read/write `.xlsx` through the same code.

`table.joinByKey` joins spreadsheet rows to model entities by `globalId`, `tag`,
`name`, or an indexed `property` (`pset`/`prop` params) and produces three outputs:
`matched` (one row per uniquely matched entity, with a `GlobalId` column added),
`unmatched` (no entity claims the row's key), and `ambiguous` (the row matches
**several** entities, or its uniquely-matched entity is also uniquely claimed by
**another** row — reported with a `MatchedGlobalIds` column, never silently resolved
to the first match). `tag`/`property` reuse `@ifc-lite/mutations`' row-matching index
builder rather than re-scanning the model per row; that needs bulk entity-table
access (`FlowHost.tables()`), which all three hosts provide — the viewer, `ifc-lite
flow run`, and MCP `run_flow` — each over the same mutation overlay its writes go
through, so a join sees properties written earlier in the session or run.

`model.applyTable` writes a table's columns back as property mutations, one entity
per row (the row key names the target's GlobalId — `table.joinByKey`'s `matched`
output is the usual source). Each column writes through the pset/prop its `mapping`
param names, or its own `binding` when the table came from `table.fromEntities`. A
cell that does not parse as its column's declared type is reported per row in
`problems` and **not written** — never coerced to `0`/`''`/`false`.

`model.applyTable` never deletes a property. An empty cell, including a cell a reader could
not parse or a short row's missing field, leaves the property as it is. Those cells are
already reported in the reader's `problems` output, so a typo in a spreadsheet can never
quietly erase a value.

```json
{
  "id": "csv", "type": "core.string", "params": { "value": "Tag,FireRating\nT-100,REI90\n" }
}
```
```json
{ "id": "read", "type": "table.readCsv", "params": { "columns": [{ "name": "Mark", "type": "string" }, { "name": "FireRating", "type": "string" }] } },
{ "id": "walls", "type": "model.byType", "params": { "type": "IfcWall" } },
{ "id": "join", "type": "table.joinByKey", "params": { "strategy": "property", "column": "Mark", "pset": "Pset_Fabrication", "prop": "Mark" } },
{ "id": "apply", "type": "model.applyTable", "params": { "mapping": [{ "column": "FireRating", "pset": "Pset_WallCommon", "prop": "FireRating" }] } }
```

`packages/cli/src/commands/flow-table-connectors.test.ts` runs this pilot workflow
(`ReadCsv → JoinByKey → ApplyTable`) end to end against a real model, including a
duplicate match value that must land in `ambiguous`, not get resolved to either
entity.

`strategy: "tag"` works in the viewer. Headless (`ifc-lite flow run`, MCP) it
currently matches nothing, because the CLI's columnar parser does not populate `Tag`
(#1765). Use a `property` join, as above, until it does.

## Creating elements, and re-running

`element.wall`, `element.column`, `element.beam` and `element.slab` build
parametric specs (a value, not yet an element); `model.addElement` writes
them. That node is **tracked**: it owns the elements it creates.

- Each output lane gets a GlobalId derived from the node's `trackingKey`
  (default `<graph name>/<node label>`) and the lane key — never from the
  model id, the graph id, or the run. Re-running the same graph on the same
  model, on a re-exported copy, or after a reload finds the same elements.
- Per lane the runtime decides **create** (new lane), **update** (inputs
  changed: the element is replaced under the same GlobalId), or **keep**
  (nothing to write). Lanes that vanished since the last run are
  **removed** — the orphan Dynamo leaves behind. A tracked node deleted
  from the graph (or given a new tracking key) has its whole set removed
  on the next run.
- An **update** replaces the product; the representation items of the
  previous body stay in the exported file as unreferenced entities (the
  store tombstones the product only). A stable GlobalId says the element
  is the same one, not that the file's entity set is unchanged.
- The tracked sets live in a sidecar, not in the graph: `ifc-lite flow
  run` writes `<graph>.tracking.json` beside the graph (`--tracking F`,
  `--no-tracking`). A graph is reusable across models; its tracked sets
  are not.
- `tracking: "replace"` on a node re-creates every lane under fresh
  GlobalIds and removes the previous set; `"disabled"` computes without
  writing.
- A lane keyed by index (a list of numbers rather than of entities) is
  stable only while the list keeps its order; the run log warns. Drive
  creation from entities (grid axes, storeys, existing elements) when the
  set can change in the middle.

`model.addElement` refuses to create under a GlobalId that already belongs
to a foreign element — change the tracking key rather than overwrite.
Geometry is parametric only (what `bim.store.add*` can author); there is no
BRep/Solid write path.

A run is one undo step in the viewer: every write the graph made is tagged
as one batch (`bim.mutate.batchAsync`), so Ctrl+Z reverts the whole run.

## Where a node can run

Nothing is declared "browser-only" or "server-only". A node states what it
requires (a backend feature such as `viewer`, a network bridge, a named
secret) and the host reports what it offers. Viewer nodes are **no-ops**
on a headless host and pass their entities through, so a graph that
colorizes failures runs unchanged in CI. `ifc-lite flow validate` and the
editor show the same per-node report.

## Programmatic use

```ts
import { runFlow, parseFlowDocument, MemoCache } from '@ifc-lite/flow';
import { createStandardRegistry, BROWSER_FEATURES } from '@ifc-lite/flow-nodes';

const registry = createStandardRegistry();
const doc = parseFlowDocument(await (await fetch('/flows/audit.flow.json')).text());
const cache = new MemoCache();
const result = await runFlow(doc, { host: { bim }, registry, features: BROWSER_FEATURES, cache });
for (const o of result.graphOutputs) console.log(o.label, o.data);
```

Re-running with the same `cache` recomputes only nodes whose inputs,
params, or model revision changed. Every write node bumps the cache's write
generation, so reads never serve a memo taken before a write. Nodes that
reach the network are never served from the memo: `HttpRequest` always
sends its request again, and a Script node is recomputed on every run in
which its code called `bim.network.fetch` (a Script that makes no request
stays memoised).

## Script nodes

Two nodes execute user code in the QuickJS sandbox, with the sandbox's `bim`
API (the same one the script console and extensions see, which is not the
full SDK). Both receive `inputs.a`, `inputs.b`, `inputs.c` and return the
value of their last expression; sandbox permissions follow the graph's
grants, so mutation is enabled only when a `model.mutate` grant exists.

They differ only in the **access** their ports declare, which is what decides
whether the runtime lifts them:

| Node | Ports | Sees | Returns |
|---|---|---|---|
| `script.run` | `item` | one element per lane — a list on an input runs the code once per element | any value (`result`) |
| `script.list` | `list` | the whole list at once | an array (`items`); anything else is an error |

Use `script.run` for a per-element predicate or computation, and
`script.list` when the answer depends on the whole set — sorting, ranking,
top-N, de-duplication, comparing one element against the rest. An entity
arrives as `{ globalId, modelId, expressId }`, which is also a `bim.*` ref.

Each lane is evaluated in its own variable environment, so `const` and `let`
in the code mean what they say and nothing carries over from the previous
lane. The code is plain **JavaScript**, not TypeScript, and top-level
`await` is not available.

The `code` parameter is a `code` param kind rather than a plain string, which
is the editor's cue to give it a multi-line editor: the Flow panel's
inspector shows a monospace textarea, and the ⤢ button beside it opens the
full CodeMirror editor (the same `bim.*` completions as the script console).

## Network requests and secrets

`http.request` issues one `https:` GET/POST to a host the graph explicitly
grants. A `network.fetch:<host>` capability names the exact hostname (or a
single-label wildcard, e.g. `network.fetch:*.example.com` — the `*` never
spans a `.`); it is matched against `new URL(url).hostname`, never the raw
URL string, so a spoofed suffix (`api.example.com.evil.net`) or a userinfo
trick (`https://user@api.example.com@evil.net/`, whose real hostname is
`evil.net`) does not match a grant for the real host. Only `https:` is
supported — `http:`, `file:`, and `data:` are always refused — and a
redirect response is refused rather than followed. See
`packages/sandbox/src/network-request.ts` for the full policy and its
rationale.

In the viewer, `http.request` runs subject to the browser's own CORS
enforcement: a host that does not send `Access-Control-Allow-Origin` for
the request fails with an explicit "likely CORS" message, never a silent
empty result. The CLI and MCP have no such restriction (Node's `fetch` is
not CORS-limited).

A node param may reference an environment secret with `{{secret:NAME}}`
(inside a plain string or nested in a `json`-kind param, such as a header
map). The graph must also declare `secret.read:NAME` as a capability —
an undeclared or declared-but-unset reference is a **validation error
raised before the run starts**, not a silently empty string. Secrets are
resolved from `process.env` **only** by `ifc-lite flow run` and MCP's
`run_flow`. The viewer's `HostFeatures.secrets` is always empty, so a graph
needing a secret shows `unavailable` in the panel before it ever runs.
`ifc-lite flow validate` checks against its own environment: a referenced
secret counts as available there only when the graph declares it and the
variable is set to a value at least 6 characters long (the redaction
minimum below), the same conditions `flow run` enforces.

Every secret value at least 6 characters long is redacted — as
`<secret:NAME>` — from run logs, node outputs, error messages, and
`--json`/MCP output, including a value that comes back inside a fetched
response body (a server echoing an `Authorization` header, for example).
Redaction happens once, right before output leaves the process, so it
catches a secret wherever it resurfaces in the run's own result — not just
at the point it was substituted into a param.

```json
{
  "capabilities": ["network.fetch:api.example.com", "secret.read:API_TOKEN"],
  "nodes": [
    {
      "id": "req",
      "type": "http.request",
      "params": {
        "url": "https://api.example.com/status",
        "headers": { "Authorization": "Bearer {{secret:API_TOKEN}}" }
      }
    }
  ]
}
```

### BCF API nodes

Three nodes talk to a BCF API (OpenCDE) server through `@ifc-lite/bcf-api`,
with every request going through the same gated transport as
`http.request`: `https:` only, and the `baseUrl` hostname must match a
declared `network.fetch:<host>` capability.

- `bcf.listTopics` lists a project's topics (optional OData `filter`,
  `orderby`, `top`) as a table keyed by `guid`, with columns `title`,
  `status`, `type`, `priority`, `assigned_to`, `creation_date`,
  `modified_date`, `labels` (`;`-separated) and `description`, plus the raw
  topic list and a `count`.
- `bcf.createTopic` creates one topic from its params, or one per row when a
  table is wired into `rows` (same column names as `bcf.listTopics`; an empty
  cell falls back to the param). Every row is validated before the first
  request, and it outputs the created `guids`.
- `bcf.addComment` posts a comment to `topicGuid`. Wiring `bcf.createTopic`'s
  `guids` into its `topicGuid` input comments on each new topic.

Each takes `baseUrl` (up to but excluding the version segment), `version`
(default `2.1`), `projectId`, and `token`, sent as
`Authorization: Bearer <token>`. Put the token in a secret rather than the
graph. The nodes are never memoised, so every run asks the server again.

```json
{
  "capabilities": ["network.fetch:bcf.example.com", "secret.read:BCF_TOKEN"],
  "nodes": [
    {
      "id": "open",
      "type": "bcf.listTopics",
      "params": {
        "baseUrl": "https://bcf.example.com/bcf",
        "projectId": "my-project",
        "token": "{{secret:BCF_TOKEN}}",
        "filter": "topic_status eq 'Open'"
      }
    },
    {
      "id": "sheet",
      "type": "table.writeCsv"
    }
  ],
  "edges": [{ "from": ["open", "table"], "to": ["sheet", "table"] }]
}
```

### Receiving a Speckle model

`speckle.receive` fetches one Speckle model version and writes its walls,
floors, flat roofs, columns and beams into a target storey, with the Revit
parameters as `Speckle_TypeParameters` / `Speckle_InstanceParameters`
property sets and the source identity as `Speckle_Source`. Its `url` is
the address you copy from the Speckle web app
(`https://<server>/projects/<project>/models/<model>`, optionally
`@<version>`; legacy `/streams/<id>/commits/<id>` and
`/streams/<id>/objects/<id>` URLs work too). It speaks to Speckle only
through the same gated request function as `http.request`, so the graph
must grant the server's host, and a private project's token comes in as a
secret:

```json
{
  "capabilities": [
    "model.read", "model.create", "model.delete",
    "model.mutate:Speckle_Source", "model.mutate:Speckle_TypeParameters", "model.mutate:Speckle_InstanceParameters",
    "network.fetch:app.speckle.systems", "secret.read:SPECKLE_TOKEN"
  ],
  "nodes": [
    { "id": "storeys", "type": "model.byType", "params": { "type": "IfcBuildingStorey" } },
    { "id": "first", "type": "core.first" },
    {
      "id": "rx",
      "type": "speckle.receive",
      "params": {
        "url": "https://app.speckle.systems/projects/<project>/models/<model>",
        "token": "{{secret:SPECKLE_TOKEN}}"
      }
    }
  ],
  "edges": [
    { "from": ["storeys", "entities"], "to": ["first", "items"] },
    { "from": ["first", "item"], "to": ["rx", "storey"] }
  ]
}
```

Where the host enforces grants, the three `model.mutate:Speckle_*` grants
above are needed exactly as spelled (pset grants match by name), and
`model.delete` is checked only when a receive replaces elements an earlier
receive wrote.

Everything the mapping cannot reproduce is reported on the `refusals`
output, by Speckle type, reason and count, and nothing is dropped silently.
Display meshes are never written: the element body is rebuilt parametrically.
The mapping table and its limits are in
[Speckle → IFC mapping](../architecture/speckle-mapping.md).

### Running a graph in CI, with secrets from GitHub Actions

A workflow can install the CLI, run a graph with a secret passed through
`env:`, and publish the result — the graph declares exactly which secret
it needs (`secret.read:API_TOKEN`) and which host it may reach
(`network.fetch:api.example.com`); nothing beyond that is available to it,
and the secret is redacted from anything the job uploads or comments.

```yaml
# .github/workflows/flow-audit.yml (illustrative — not run in this repo's CI)
name: Flow audit
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # the summary comment

jobs:
  audit:
    # Repository secrets are not passed to pull requests from forks, and the
    # token cannot comment there, so run only for same-repository branches.
    # Audit a fork's change after merge, or from a maintainer-triggered
    # workflow. Never use `pull_request_target` with a checkout of the fork's
    # code to reach the secret: that runs untrusted code with it.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install ifc-lite CLI
        run: npm install -g @ifc-lite/cli

      - name: Run the audit graph
        id: run
        env:
          API_TOKEN: ${{ secrets.API_TOKEN }}
        # `flow run` exits 1 when the graph fails. Keep that status, but
        # write the summary output first so the comment step can report it.
        run: |
          set +e
          ifc-lite flow run graphs/fire-rating-audit.flow.json model.ifc \
            --out audit-result.ifc --json > run-summary.json
          status=$?
          set -e
          echo "ok=$(jq -r .ok run-summary.json)" >> "$GITHUB_OUTPUT"
          exit $status

      - name: Publish the audited model as a layer
        if: steps.run.outputs.ok == 'true'
        run: ifc-lite layer publish audit-result.ifc --layer fire-rating-audit

      - name: Comment the run summary on the PR
        # Also after a failed run (the job still fails from the step above).
        if: always() && steps.run.outputs.ok != ''
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            // run-summary.json was already redacted by `flow run` itself —
            // secrets never reach an artifact, an env dump, or this comment.
            const summary = JSON.parse(fs.readFileSync('run-summary.json', 'utf-8'));
            const body = `Flow audit: ${summary.ok ? 'passed' : 'FAILED'} (` +
              Object.entries(summary.nodes).map(([k, v]) => `${v} ${k}`).join(', ') + ')';
            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body,
            });
```

`API_TOKEN` is scoped by two independent things: the repository secret
(`${{ secrets.API_TOKEN }}`, GitHub's own access control) and the graph's
own `secret.read:API_TOKEN` capability (`ifc-lite`'s — a graph that does
not declare it cannot read the env var even though the workflow set it).
Nothing the workflow uploads, comments, or logs can carry the raw value:
`flow run --json` redacts it before it is ever written to
`run-summary.json`, so every consumer downstream — the artifact, the PR
comment, the job log — only ever sees `<secret:API_TOKEN>` if the value
happened to surface at all.

### Autodesk Platform Services (APS)

Two nodes read Autodesk model data into a graph, so Revit or ACC properties
can be joined to an IFC model:

- `aps.token` gets an APS access token: a 2-legged client-credentials token
  from `clientId` / `clientSecret` (`scope` defaults to
  `data:read viewables:read`), or a ready 3-legged token passed as
  `accessToken`. Its `token` output is an opaque handle. The token itself is
  never an output value, a log line or part of `--json` output, because a
  token minted from a secret is not a secret the redaction step knows about.
- `aps.modelProperties` reads a translated model's Model Derivative
  metadata, picks the master (else first) 3D view, and reads its properties.
  The output is a table with one row per object: `objectid`, `externalId`
  (for Revit, the element's UniqueId), `name`, `category`, `IfcGUID`, and
  every property as a `Group.Property` column. The `key` param picks the
  key column (default `externalId`). While APS is still extracting
  properties it answers `202`. The node retries up to `maxAttempts` times,
  waiting `retryDelayMs` between tries, then fails with a clear message.
  Credentials come from a connected `token`, or from the same credential
  params on the node itself. `region` sets the data centre (`US`, `EMEA`, …).

Both nodes reach only `developer.api.autodesk.com`, through the same
host-grant check as `http.request`. They are volatile, so every run fetches
fresh data. Run them from the CLI or MCP: the viewer has no secrets, and
APS's endpoints are not meant to be called from a browser page.

This graph joins a Revit model's properties to the walls of the loaded IFC
model through the `IfcGUID` that Revit's IFC exporter writes:

```json
{
  "flowVersion": 1,
  "id": "aps-join",
  "name": "Revit properties onto IFC walls",
  "capabilities": [
    "model.read",
    "network.fetch:developer.api.autodesk.com",
    "secret.read:APS_CLIENT_ID",
    "secret.read:APS_CLIENT_SECRET"
  ],
  "inputs": [],
  "outputs": [{ "nodeId": "join", "port": "matched", "label": "matched" }],
  "nodes": [
    {
      "id": "tok",
      "type": "aps.token",
      "params": { "clientId": "{{secret:APS_CLIENT_ID}}", "clientSecret": "{{secret:APS_CLIENT_SECRET}}" }
    },
    {
      "id": "props",
      "type": "aps.modelProperties",
      "params": { "urn": "urn:adsk.wipprod:fs.file:vf.XXXXXXXX?version=3", "region": "US", "key": "IfcGUID" }
    },
    { "id": "walls", "type": "model.byType", "params": { "type": "IfcWall" } },
    { "id": "join", "type": "table.joinByKey", "params": { "strategy": "globalId", "column": "IfcGUID" } }
  ],
  "edges": [
    { "from": ["tok", "token"], "to": ["props", "token"] },
    { "from": ["props", "table"], "to": ["join", "table"] },
    { "from": ["walls", "entities"], "to": ["join", "entities"] }
  ]
}
```

```bash
APS_CLIENT_ID=… APS_CLIENT_SECRET=… ifc-lite flow run aps-join.json model.ifc --json
```

**Getting a URN.** `urn` takes either form:

- The version id of a Docs, ACC or BIM 360 file, such as
  `urn:adsk.wipprod:fs.file:vf.…?version=N`. The Data Management API returns
  it (`GET /data/v1/projects/{project}/items/{item}/versions`, the `id` of
  each version). The node base64url-encodes it for you. An item id
  (`…:dm.lineage:…`) names no version, so the node refuses it.
- An already-encoded derivative URN, which the APS Viewer and translation
  jobs print (the `urn:` prefix the viewer adds is accepted).

The file must already be translated. Opening it once in ACC or Docs does
that; for your own OSS bucket, start a Model Derivative job first. A
2-legged token can read an ACC project only when the APS app has been added
to the ACC account as a custom integration. Otherwise, pass a user's
3-legged token as `accessToken: "{{secret:APS_TOKEN}}"` and declare
`secret.read:APS_TOKEN`.

## Editing a graph

In the viewer's Flow panel:

- **Add** nodes from the palette; drag from an output handle to an input
  handle to connect. Incompatible ports are greyed out while dragging, and a
  refused connection says why.
- **Re-route** an edge by dragging either of its ends onto another port; drop
  it on empty canvas to unplug it.
- **Delete** an edge by clicking it (it goes dashed) and pressing Delete or
  Backspace; the same keys delete a selected node and its edges.
- An input takes **at most one** edge — connecting a second one replaces the
  first — and a connection that would close a cycle is refused.

## Examples

The panel ships a ladder of runnable examples, from a two-node count to a
tracked column grid, under `apps/viewer/src/lib/flow/examples/`. They open
as an editable copy, and because they are ordinary `*.flow.json` documents
they also run headlessly:

```sh
ifc-lite flow run apps/viewer/src/lib/flow/examples/03-quantity-takeoff.flow.json model.ifc --json
```

`packages/cli`'s `flow.test.ts` runs every one of them against a real model,
so an example that stops working fails the build.
