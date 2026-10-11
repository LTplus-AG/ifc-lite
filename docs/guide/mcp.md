# MCP for AI Agents

The `@ifc-lite/mcp` package turns any IFC model into a set of tools an LLM agent can call. It speaks the [Model Context Protocol](https://modelcontextprotocol.io) over JSON-RPC, so agents like Claude Code, Claude Desktop, Cursor, Windsurf, Goose, and Zed can query, validate, edit, and visualize real building models directly, no browser and no bespoke integration required. For a BIM audience: it is the same query, geometry, clash, IDS, BCF, and export capabilities you get from the [CLI](cli.md), exposed as agent-callable tools with a permission model on top.

The server bundles the same headless kernel the [CLI](cli.md) and [server](server.md) use, and can optionally drive the WebGL viewer so an agent paints results into a live 3D scene.

For 5D workflows, `cost_data` returns the canonical IFC cost graph and
`cost_evaluate` evaluates an `item` or `value` by local `express_id`. Pass
`model_id` whenever multiple models are loaded. Amounts are decimal strings,
diagnostics retain model-qualified references, and results describe the loaded
source snapshot rather than pending mutation overlays.

## Quickstart

### stdio (local agents)

The default transport is stdio, the mode Claude Desktop and Cursor expect. Pass one or more IFC files as positional arguments and they are preloaded into the model registry:

```bash
# Single model over stdio
ifc-lite mcp ./model.ifc

# Read-only (mutation tools are hidden, not just refused)
ifc-lite mcp ./model.ifc --read-only

# Federate several files into one session
ifc-lite mcp ./arch.ifc ./struct.ifc ./mep.ifc

# Also open the WebGL viewer at startup
ifc-lite mcp ./model.ifc --viewer
```

You can also invoke the package directly with `npx @ifc-lite/mcp ./model.ifc`. Both entry points share the same runtime and flags.

### HTTP (remote agents)

The Streamable HTTP transport serves remote agents:

```bash
ifc-lite mcp ./model.ifc --transport http --port 8765 --token $API_TOKEN
```

!!! warning "HTTP sessions start with an empty registry"
    In `--transport http` mode the positional files are **not** preloaded. Every
    HTTP session gets its own fresh, empty model registry. The agent loads a
    model into its session with the `model_load` tool, which needs `mutate`
    scope, so it is hidden under `--read-only`. Only the default `stdio`
    transport preloads the files you pass on the command line. This isolation is
    deliberate: two sessions that load different files which derive the same
    internal id never alias each other's state.

    A corollary: `--read-only` combined with `--transport http` produces
    sessions that have no way to load a model at all (the registry starts
    empty and `model_load` is hidden). For read-only serving of preloaded
    files, use the `stdio` transport.

By default the server binds `127.0.0.1`. Binding a non-loopback host requires either a `--token` (which becomes the bearer token for full scope) or the `--insecure` flag for development only. The token travels as a plaintext `Authorization` header: the CLI itself serves plain HTTP, so any non-loopback deployment must sit behind a TLS-terminating reverse proxy (nginx, Caddy, a cloud load balancer), or the bearer token is readable by anyone on the network path.

### Flags

| Flag | Description |
|------|-------------|
| `--transport <t>` | `stdio` (default) or `http` |
| `--port <N>` | HTTP port (default 8765) |
| `--host <h>` | HTTP host (default 127.0.0.1; non-loopback requires `--token` or `--insecure`) |
| `--token <bearer>` | HTTP bearer token that maps to full scope |
| `--insecure` | Allow a non-loopback bind without a token (development only) |
| `--read-only` | Hide mutation tools |
| `--bsdd <url>` | Override the bSDD endpoint |
| `--allow <path>` | Restrict file-system access (repeatable) |
| `--viewer` | Auto-open the 3D viewer |
| `--viewer-port <N>` | Preferred viewer port (0 = auto) |
| `--open` | Auto-open the viewer **and** open its URL in the browser |

## Scopes and permissions

Every tool declares the scope a caller needs. At `tools/list` time the server filters the advertised set by the session's scope, so an agent never even sees a tool it is not allowed to call, which keeps it from attempting a forbidden operation.

| Scope | Grants |
|-------|--------|
| `read` | Discovery, query, geometry metrics, viewer reads |
| `validate` | IDS validation, model audit |
| `export` | Data and geometry export |
| `mutate` | Property/attribute edits, entity create/delete, model load/save |
| `admin` | All of the above |

Two presets ship out of the box:

- **Full access** (`read`, `validate`, `mutate`, `export`, `admin`) is the default.
- **Read-only** (`read`, `validate`, `export`) is what `--read-only` selects; it omits `mutate`.

A scope can also carry an optional `modelIds` allowlist to restrict a session to specific models.

## What the server exposes

Tools are grouped by capability. Everything below is registered in the default tool registry; the handful of tools that are declared but not yet implemented are called out as **planned**.

| Category | Tools |
|----------|-------|
| Discovery | `model_info`, `model_list`, `model_load`, `model_unload`, `schema_describe` |
| Query | `query_entities`, `count_entities`, `get_entity`, `get_entities_bulk`, `spatial_hierarchy`, `containment_chain`, `relationships`, `properties_unique`, `materials_list`, `classifications_list`, `georeferencing`, `units`, `cost_data`, `cost_evaluate` |
| Geometry | `geometry_bbox`, `geometry_volume`, `geometry_area`, `geometry_get` *(planned)*, `raycast` *(planned)* |
| Clash | `clash_check`, `clash_matrix` |
| Validation | `ids_validate`, `ids_explain`, `model_audit`, `gherkin_check` *(planned)* |
| IDS authoring | `ids_audit`, `ids_lint`, `ids_read`, `ids_apply_ops`, `ids_write`, `ids_schema_search`, `ids_schema_entity`, `ids_schema_pset`, `ids_diff`, `ids_preview` *(planned)*, `ids_infer` *(planned)*, `ids_coverage` *(planned)*, `ids_test` *(planned)* |
| Mutation | `entity_set_property`, `entity_delete_property`, `entity_set_attribute`, `entity_create`, `entity_delete`, `mutation_batch`, `mutation_undo`, `mutation_diff`, `model_save` |
| Hosted modelling | `place_opening`, `place_door`, `place_window` |
| Physical edits | `edit_hosted_element`, `edit_element_geometry`, `copy_elements`, `duplicate_element`, `array_elements` |
| Native Room | `query_rooms`, `room_command` |
| Design modelling | `place_curtain_wall`, `place_grid`, `place_grid_column` |
| Wall joins | `join_walls` |
| BCF | `bcf_topic_list`, `bcf_topic_create`, `bcf_topic_update`, `bcf_topic_close`, `bcf_viewpoint_create`, `bcf_export` |
| bSDD | `bsdd_search`, `bsdd_class`, `bsdd_property_sets`, `bsdd_match` |
| Diff | `model_diff`, `quantity_diff` |
| Export | `export_ifc`, `export_csv`, `export_json`, `export_glb`, `export_obj`, `export_ifcx`, `export_usd`, `export_pdf_report` *(planned)* |
| Flow | `describe_flow`, `run_flow`, `propose_flow`, `resume_flow` |
| Viewer | `viewer_ask`, `viewer_open`, `viewer_close`, `viewer_status`, `viewer_colorize`, `viewer_isolate`, `viewer_hide`, `viewer_show`, `viewer_reset`, `viewer_fly_to`, `viewer_set_section`, `viewer_clear_section`, `viewer_color_by_storey`, `viewer_color_by_property`, `viewer_get_selection`, `viewer_wait_for_selection`, `viewer_describe_selection` |
| Draft layers & review | `create_draft_layer`, `draft_apply_ops`, `publish_layer`, `diff_layer`, `dry_run_merge`, `list_conflicts`, `request_review`, `add_review_feedback`, `get_review_feedback`, `add_review_topic`, `respond_to_review` |

### IDS authoring

The IDS authoring tools work on IDS documents and need no model. They are
stateless: a document travels between calls as Studio JSON (the `doc` that
`ids_read` and `ids_apply_ops` return), with a stable UUID for every
specification, facet and constraint. Reading the same XML twice gives the
same ids.

`ids_apply_ops` is the only tool that changes a document. It takes typed
operations (IDS ops vocabulary v1; the JSON Schema is part of the tool's
input schema) and passes the whole batch through the grounding gate first:
every op is validated, and every literal name is checked against the IFC
schema tables (entities, predefined types, attributes, property sets,
properties, enumeration values, data types). If one name is wrong, nothing
is applied and the tool returns `INVALID_INPUT`. `details.issues` lists each
problem with its gate code, path and ranked candidates, and the text says
the same:

```text
The grounding gate refused the batch; nothing was applied.
- GATE-PROP-001 at ops[2].payload.facet.baseName: … Did you mean: FireRating?
```

A typical loop: look names up with `ids_schema_search`, `ids_schema_entity` or
`ids_schema_pset`. Build the document with `ids_apply_ops`, which also returns
its lint diagnostics. Apply a diagnostic's quick fix by passing its `ops`
back to `ids_apply_ops`. Finish with `ids_write`. `ids_write` reads its own
XML back, audits it and refuses a document with audit errors, so Studio JSON
edited by hand cannot get past the gate that way. It also returns the
`studio.json` sidecar that keeps the node ids next to the XML.

`ids_diff` compares two IDS revisions (`before_xml` / `before_path`,
`after_xml` / `after_path`). It returns added, removed and changed entries,
each with its XML path and one plain-language line. `ids_preview`,
`ids_infer` and `ids_coverage` evaluate an IDS against a loaded model, and
`ids_test` runs `.idsz` test suites. These four are declared with their
final inputs but answer `UNSUPPORTED_OPERATION` until their engines ship.

`join_walls` takes `a_express_id`, `b_express_id`, optional `model_id` and optional `options` (`Name`, `priority: 'a' | 'b'`, `tolerance` in metres and `priorities: { a?: number[]; b?: number[] }`). It uses `bim.store.joinWalls` and the canonical Model workspace core. Both walls must be straight and in the same placement frame. Unreadable hosted cuts, or an opening stranded by either joined end face, refuse atomically. One `mutation_undo` restores the complete earlier wall graph and any replaced relationship. The IFC export contains the join; headless geometry queries continue to read parsed geometry.

`place_opening`, `place_door` and `place_window` run the same hosted creation core as the Model workspace and `bim.store.addOpening` / `addHostedDoor` / `addHostedWindow`. Supply `host_express_id` within the chosen `model_id` and PascalCase `params`. Offsets, sills and dimensions are metres in the wall's local frame; windows require `Sill`. Cuts outside the wall, overlapping source or overlay openings, and unreadable opening geometry are refused without a partial graph. One `mutation_undo` removes the complete placement. IFC2X3, IFC4 and IFC4X3 are supported. The exported STEP carries the void/fill graph; MCP geometry tools still read parsed geometry.

```json
{
  "name": "place_door",
  "arguments": {
    "model_id": "building",
    "host_express_id": 1222,
    "params": { "Offset": 8, "Width": 0.9, "Height": 2.1, "Name": "D1" }
  }
}
```

!!! tip "Pinning the GlobalId of a created entity"
    `entity_create` takes an optional `global_id`: the GlobalId of the new
    entity, the MCP counterpart of the `GlobalId` parameter the in-store
    builders and `bim.store.add*` accept. It must be a valid 22-character IFC
    GUID (the `isValidIfcGuid` rule from `@ifc-lite/encoding`), the class must
    derive from `IfcRoot` (the value is written to attribute 0), and it must not
    already be carried by an entity in the model, parsed or created this
    session. Each violation is refused with `INVALID_INPUT` and nothing is
    queued; a GlobalId given both as `global_id` and as a different
    `attributes[0]` is refused too. Without `global_id` the tool behaves as
    before.

!!! tip "`model_diff` and re-exported models"
    `model_diff` compares by GlobalId, so two files that describe the same
    building read as *the whole model deleted and re-added* when the second was
    re-exported from scratch. Pass `by_content: true` to route the same two
    models through the [`@ifc-lite/diff` engine](model-diff.md), which matches
    entities by content. It is opt-in and stays off by default: an ambiguous
    group has no honest scalar form, so turning it on would change what the
    existing numbers mean. Either way the diff reflects any edits the session
    has queued but not yet saved, and says how many. `key_from` (`"Tag"` or
    `"Pset.Prop"`) keys the comparison on an authored identifier instead of
    GlobalId, exactly as the CLI's `--key-from` does. See [Content diffing over
    MCP](model-diff.md#mcp-usage) and [Stable Element Identity](stable-identity.md).

!!! tip "Reading back an edit you just made"
    A `model_id` names a *session*, not a file. `entity_set_property`,
    `entity_set_attribute`, `entity_create` and `entity_delete` queue their edits
    in an overlay that only reaches disk at `export_ifc` / `model_save`, so the
    read tools fold that overlay in and answer about the model as the session
    has it.

    That covers existence, attributes, properties, quantities **and
    containment**: `get_entity`, `get_entities_bulk`, `query_entities` (filters
    included — a query for the value you just wrote finds it, and `in_storey`
    finds an entity you created and placed with a queued
    `IfcRelContainedInSpatialStructure`), `count_entities`, `model_info`,
    `model_list`, `properties_unique`, `materials_list`,
    `classifications_list`, `spatial_hierarchy`, `containment_chain`,
    `model_audit` and `model_diff` — plus the `ifc-lite://model/{id}/manifest`,
    `…/entity/{globalId}` and `…/spatial-tree` resources. A created entity is
    reachable by the GlobalId you gave it, and by the `expressId` every
    `query_entities` row carries; a deleted one is reported as not found, and a
    deleted `IfcRelContainedInSpatialStructure` or `IfcRelAggregates` record
    stops affecting the containment reads above. **Only containment.** The
    `relationships` tool reads voids, fills, groups and connections from the
    parsed graph, so an `IfcRelVoidsElement` this session created or deleted
    shows up there only after a save and reload.

    `model_audit` scores identity and naming from effective classes, GlobalIds
    and Names, including queued retypes and edits.

    **One GlobalId, one entity, whichever tool asks.** A GlobalId is supposed to
    be unique and in practice is not — a session can create an entity under an id
    the file already uses. `get_entity`, `get_entities_bulk`, `entity_set_*`,
    `entity_delete` and `bsdd_match` all resolve it the same way: **an entity
    this session created wins over a same-GlobalId entity in the file**, and a
    deleted entity never resolves at all. `get_entities_bulk` additionally
    reports any key that named more than one live entity in
    `ambiguousGlobalIds` (`globalId`, every `expressIds` it saw, and which one it
    `returned`), so a duplicate is something you are told about rather than
    something you have to notice. Address the other one by `express_id`.

    **Type names are IfcPascalCase** in `model_info.typeCountsTop20`,
    `count_entities(group_by: 'type')` and `model_diff.typeDiffs` alike — the
    first two used to emit the raw uppercase STEP key. `count_entities` also
    honours `type` on the `group_by: 'type'` branch now (it was ignored), and
    expands subtypes the way `query_entities` does.

    **`count_entities` counts BIM products on every `group_by`.** It is the
    aggregate form of `query_entities` and answers over the same set. The
    ungrouped total and `group_by: 'type'` used to fold raw STEP records
    instead — geometry and property-value lines included — so the same tool
    answered 44,249 by type and 128 by storey for one model. For the raw STEP
    record count, which is a file statistic rather than a query, use
    `model_info` (the MCP analogue of `ifc-lite info`).

    **`pendingMutations` is a number wherever it appears, never an object.**
    `model_diff` used to publish a `{ base, head }` object under that name
    inside `contentDiff`; the per-side split now lives in
    `contentDiff.pendingMutationsBySide` and `pendingMutations` is the scalar
    total, at the top level and inside `contentDiff`. This is about its *type*
    when present, not about whether it is present — see below.

    Every one of those payloads carries `pendingMutations` — the same number
    `mutation_diff` reports — whenever the session has unsaved edits, and the
    field is **absent** when it has none. That is the line between "in this
    session" and "on disk": nothing is written until you call `export_ifc` or
    `model_save`.

    **The saved file agrees with the session, including under a filter.**
    `export_ifc`'s optional `global_ids` allowlist resolves against the folded
    model, so an entity this session created can be named in it and lands in the
    file. It used to be resolved and then filtered against the parsed model
    alone, which dropped created entities from the output silently.

    An allowlist that matches **nothing** now fails with `ENTITY_NOT_FOUND`
    rather than exporting the whole model: an empty match set used to fall
    through to an unfiltered save, so asking for one entity could write every
    entity in the model to disk and report success. Nothing is written when it
    fails. Ids that match nothing while *others* do are not an error — they come
    back in `unmatchedGlobalIds` and the matched ones still export.

    **What does not fold, and therefore never claims `pendingMutations`:**
    `relationships` (voids, fills, groups and connections come from a
    parser-side extractor with no overlay seam — unlike containment, which
    routes through the backend the mutation tools share), `units` and
    `georeferencing` (header data no mutation tool writes), and the geometry,
    clash and viewer tools (the parsed geometry, which queued edits do not
    regenerate). Save and reload to bring those up to date.

!!! tip "Schema reach beyond IFC4"
    The parser's entity registry is generated from IFC4_ADD2_TC1, and both
    `model_audit` and `schema_describe` used to answer from it alone. They now
    consult every bundled schema. `model_audit`'s GlobalId-uniqueness check
    covers the 39 IFC2X3 and 80 IFC4X3 `IfcRoot` classes the pin has no row for
    — it used to skip them silently and score the file clean on identity without
    having looked. `schema_describe` answers for those classes instead of
    rejecting them as unknown; its payload carries `schemaSource`, which reads
    `IFC4_ADD2_TC1` when the pinned registry answered (attributes with their
    EXPRESS types) and `bundled-schema-union` when it did not (attribute names
    in positional order, no types).

!!! tip "Flow graphs: describe_flow / run_flow"
    A `.flow.json` graph — the same document the viewer's Flow editor authors
    and `ifc-lite flow run` executes from the CLI — can be discovered and run
    headlessly by an agent. `describe_flow` takes `flow` (the parsed document
    inline) or `flow_path` (subject to `--allow`), and returns the graph's
    declared inputs (name, kind, default) and outputs (node/port, value kind,
    access) plus registry-aware wiring diagnostics. It never throws on an
    invalid graph — a declared output naming a port no node has comes back as
    `ok: false` with `diagnostics`, not an opaque error, because that
    defect is exactly what an agent calls this tool to find.

    `run_flow` takes the same `flow`/`flow_path`, an optional `model_id`, and
    `inputs` (Player parameter overrides keyed `"nodeId.param"`). An `inputs`
    key naming no declared parameter is rejected by name rather than dropped
    silently — the graph never runs on defaults while reporting success. The
    result carries `ok`, per-node status counts, a `tracking` summary
    (created/updated/kept/removed elements for tracked write nodes), and the
    declared `outputs`' values; a table output's rows are capped with a
    `truncated` flag. A failed node marks the whole run `ok: false`, and any
    output downstream of it comes back with no data rather than reporting the
    half-applied model as a success.

    AI nodes are opt-in through `IFC_LITE_AI_MODEL`, `IFC_LITE_AI_API_KEY`
    and optional `IFC_LITE_AI_BASE_URL`, using the CLI's shared compatible
    transport and root budget. A review-capable `run_flow` requires a new
    `checkpoint_path` under `--allow`; it returns `pending.artifacts`,
    `pending.proposal_digest`, the original budget and the active `model_id`.
    Downstream effects stay paused. The separate authorized `resume_flow`
    takes the same graph/inputs, `checkpoint_path` and exact `approved_digest`.
    It checks current mutate scope and native model state, consumes one disk
    claim, and restores completed outputs without requesting a new answer.
    Changing the evidence, graph or budget receipt refuses continuation.
    Downstream AI requests share the existing allowance. Supply a new
    `next_checkpoint_path` when another review remains ahead; persistence
    failure after a claim is recorded as partially committed. A lost owner
    cannot apply the same record again. Cancellation does not undo effects
    already completed before a pause or failure.

    `element.wall`, `element.column`, `element.slab`, `element.beam`,
    `element.stair` and `element.railing` specs
    connected to `model.addElement` create geometry in the selected loaded
    model through the same atomic builders as the SDK and viewer. The supplied
    storey must have a readable placement; dimensions are metres. Each creation
    is one compound operation for `mutation_undo`. A failed creation leaves no
    partial helper graph or journal entries. Stair/railing specs use the same
    canonical parameters as their SDK methods; stairs aggregate one flight.
    Each call has fresh tracking, so persistent update/remove needs a caller
    retaining a `TrackingStore`. This does not roll back earlier
    successful nodes in the flow. Free door/window placement remains unsupported
    by this adapter; use the hosted placement tools with an actual host.

!!! note "Planned tools return a clean error"
    `geometry_get`, `raycast`, `gherkin_check`, and `export_pdf_report` are
    registered so agents can discover them, but they currently return an
    `UNSUPPORTED_OPERATION` result rather than data. Mesh geometry (`geometry_get`)
    and `raycast` need the WASM geometry pipeline; `gherkin_check` awaits the bSI
    Gherkin grammar; `export_pdf_report` is slated for a later release.

### Resources

Live model state is exposed as MCP resources under the `ifc-lite://` URI scheme, so an agent can read current state without a tool round-trip:

```text
ifc-lite://server/manifest
ifc-lite://model/{model_id}/manifest
ifc-lite://model/{model_id}/entity/{global_id}
ifc-lite://model/{model_id}/spatial-tree
ifc-lite://model/{model_id}/materials
ifc-lite://model/{model_id}/property-sets
ifc-lite://viewer/status            (open/closed, port, client count)
ifc-lite://viewer/selection         (live; supports resources/subscribe for push updates)
```

### Prompts

The server ships pre-baked prompts that encode BIM expertise, so an agent can run a whole workflow from one prompt: `audit_model`, `find_fire_rated_doors`, `generate_bcf_from_ids`, `compare_versions`, `space_program_check`, `clash_review`, `prop_quality_pass`, `migrate_to_ifcx`, `visual_audit`, `interactive_property_inspect`, and `visualize_query`.

## Live 3D viewer

When the viewer is open, every viewer-touching tool drives the live scene, and any element the user clicks in the browser flows back to the agent. The intended etiquette is:

1. Call `viewer_ask` with a `reason`; it returns suggested wording so the agent can ask the user for permission.
2. After the user agrees, call `viewer_open`; the result includes the URL to share.
3. Drive the visualization with `viewer_colorize`, `viewer_color_by_property`, `viewer_isolate`, `viewer_fly_to`, `viewer_set_section`, and friends.
4. Subscribe to `ifc-lite://viewer/selection` to be notified on each pick. `viewer_get_selection` reads the latest pick; `viewer_wait_for_selection` blocks until the next click.
5. `viewer_close` when done.

## Wiring it into a client

=== "Claude Code"

    Register the server with the `claude mcp add` command:

    ```bash
    claude mcp add ifc-lite -- npx -y @ifc-lite/mcp /abs/path/to/model.ifc
    ```

    Or commit a project-scoped `.mcp.json` so the whole team shares it:

    ```json
    {
      "mcpServers": {
        "ifc-lite": {
          "command": "npx",
          "args": ["-y", "@ifc-lite/mcp", "/abs/path/to/model.ifc"]
        }
      }
    }
    ```

=== "Claude Desktop"

    Add the server to `claude_desktop_config.json`:

    ```json
    {
      "mcpServers": {
        "ifc-lite": {
          "command": "npx",
          "args": ["-y", "@ifc-lite/mcp", "/abs/path/to/model.ifc"]
        }
      }
    }
    ```

    Restart Claude Desktop and the ifc-lite tools appear in the tool picker.

=== "Streamable HTTP client"

    Start the server over HTTP, then point any MCP-aware Streamable HTTP client
    at it with the bearer token:

    ```bash
    ifc-lite mcp ./model.ifc --transport http --port 8765 --token my-secret
    ```

    ```
    Endpoint:   http://127.0.0.1:8765
    Header:     Authorization: Bearer my-secret
    ```

    Remember to call `model_load` first: an HTTP session starts empty.

Cursor, Windsurf, Goose, and Zed all accept the same `npx @ifc-lite/mcp <file>` stdio command.

## Errors that keep the agent in the loop

Domain errors come back inside the tool result with `isError: true` and a stable `structuredContent.code`, rather than aborting the JSON-RPC call. That keeps the model reasoning instead of failing the chain:

```jsonc
{
  "isError": true,
  "content": [{ "type": "text", "text": "Entity not found in model 'arch'" }],
  "structuredContent": {
    "code": "ENTITY_NOT_FOUND",
    "details": { "model_id": "arch", "express_id": 42 },
    "hint": "Use query_entities to discover valid IDs."
  }
}
```

## Programmatic embedding

For a Tauri, Electron, or Node host, build a server and wire it to a transport directly. The public surface is exported from `@ifc-lite/mcp`:

The `HttpTransport` constructor accepts `maxSessions` (default `1000`) and
`sessionIdleMs` (default `30 * 60_000`). The limit includes sessions whose
factory is still building. At capacity, a new `initialize` may reclaim the
oldest session that has been idle for the window, has no request in flight or
open event stream, and holds no unpublished layer drafts. A request settling
or an event stream closing restarts the idle window. Reclamation happens only
when admitting a new session; there is no timer sweep.

If no safe session can be reclaimed, initialization returns HTTP `503` with
`error: 'session-capacity'` and ends no session. A request for an unknown or
reclaimed session returns HTTP `404` with `error: 'unknown-session'`; the
client can initialize again without a `Mcp-Session-Id` header (an `initialize`
that still carries the old id gets the same `404`). A request that
requires a session but omits the header returns HTTP `400`. These capacity
options are available to library callers; the CLI uses their defaults. The
constructor throws a `RangeError` for a `maxSessions` that is not an integer of
at least 1 or a `sessionIdleMs` that is not a finite number of at least 0.

```ts
import {
  createMCPServer,
  StdioTransport,
  loadIfcModel,
  InMemoryModelRegistry,
} from '@ifc-lite/mcp';

const registry = new InMemoryModelRegistry();
registry.add(await loadIfcModel('./model.ifc'));

const server = createMCPServer({ version: '0.1.0', registry });
const transport = new StdioTransport();
await transport.connect(server);
```

A model returned by `loadIfcModel` exposes the existing SDK methods
`bim.store.addElementType`, `assignType`, `addMaterial`, `addMaterialLayerSet`,
`addMaterialLayerSetUsage` and `assignMaterial`. These embedded methods use
`@ifc-lite/create`'s shared schema-aware writers; they are not new JSON-RPC tool
names. Each successful call records one complete operation for the public
`mutation_undo` tool. A refused layer or layer-set field creates no orphan
helpers. Thicknesses and offsets are metres, converted to the model's units;
IFC2X3 uses its live `IfcOwnerHistory` and rejects IFC4-only fields such as
layer/set `Description`.

```ts
import { loadIfcModel } from '@ifc-lite/mcp';

const loaded = await loadIfcModel('./model.ifc', { modelId: 'building' });
const material = loaded.bim.store.addMaterial(loaded.id, { Name: 'Concrete' });
const { expressId: layerSetId } = loaded.bim.store.addMaterialLayerSet(loaded.id, {
  LayerSetName: 'Concrete layer',
  MaterialLayers: [{ Material: material.expressId, LayerThickness: 0.2 }],
});
```

For an in-process host (no child process, no sockets), use `InProcessTransport` and send JSON-RPC envelopes directly:

```ts
import { InProcessTransport } from '@ifc-lite/mcp';

const transport = new InProcessTransport();
await transport.connect(server);

const initResp = await transport.send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-05',
    capabilities: {},
    clientInfo: { name: 'host', version: '1' },
  },
});
```

The server negotiates MCP protocol version `2025-11-05` and accepts the neighbouring published revisions, downgrading anything it does not recognize.

## Why agents plus BIM

MCP is the richest integration: stateful sessions, live viewer control, subscriptions, and a permission model. But it is not the only way to give an agent BIM capability. If your agent already runs shell commands, the [CLI](cli.md) is often enough:

- `ifc-lite ask model.ifc "how many walls?"` answers common questions in plain language through a local recipe engine, with no external AI service involved.
- `ifc-lite eval model.ifc "<expr>"` runs arbitrary SDK expressions, and `ifc-lite schema` dumps the full API so an agent can discover it first.

Reach for MCP when you want the model held open across a conversation, the viewer in the loop, or scoped permissions. Reach for the CLI when a one-shot command answers the question. Both share the same kernel, so results are consistent either way.

See the [`@ifc-lite/mcp` README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/mcp) for the complete tool and resource catalogue.

### Loaded-model design placement

`place_curtain_wall`, `place_grid` and `place_grid_column` create elements in
an existing model through the same builders as the Model workspace and typed
SDK. Supply `storey_express_id`, canonical PascalCase `params`, and `model_id`
when more than one model is loaded. `place_grid_column` also requires
`binding: { GridId, IntersectingAxes: [axisIdA, axisIdB] }`; its storey-local
`Position` must match the live crossing. Profiled columns may supply `Profile`
instead of `Width`/`Depth`.

Each call creates a new element and records one `mutation_undo` batch,
including all curtain-wall parts or grid-placement helpers. Lengths are
metres; grid `Direction` is radians. These tools require mutation scope.

`edit_hosted_element` edits an existing wall-hosted opening, door or window
through the shared Model workspace core. Supply `express_id`, `model_id` when
federated, and a nonempty `patch` containing `OverallWidth`, `OverallHeight`,
`Offset` and/or `Sill` in metres. It resizes or moves the actual cut and filling
without replacing identity or relationships. Unsupported, overlapping and
out-of-host changes leave the graph unchanged. The tool requires mutation scope;
one `mutation_undo` restores the previous graph.

### Physical command edits

`copy_elements` and `array_elements` copy selections with their hosted
dependants, fresh GlobalIds and the viewer array policy. `duplicate_element`
accepts an `express_id`, explicit IFC `offset` and optional `Name`; it preserves
the viewer Duplicate naming policy and copies the complete hosted graph.
`edit_element_geometry` accepts a discriminated `operation`: `transform`
(move/rotate), `align`, `size`, `wall_endpoints`, `split`, or `trim_extend`. Coordinates
are IFC storey-local metres; rotation angles are radians. Dimension names
retain their IFC spelling (`Depth`, `XDim`, `YDim`).

Supply `model_id` when multiple models are loaded. These tools require mutation
scope. Each write records one `mutation_undo` batch including its graph helpers.
Unsupported shapes, independent hosted copies, unsafe shared geometry, read-only
access and ambiguous model routing refuse without partial IFC writes.

For `align`, provide `reference_id`, `express_ids` and `mode` (`left`, `centre`,
`right`, `top`, `middle` or `bottom`). The reference and targets must occupy one
storey. Bounds come from fresh native meshes, including current overlay edits;
install the WASM runtime. Each target receives its own storey-local translation
in one atomic batch. A selected host governs its placement dependants, which move once; joined neighbours follow and
one Undo restores the entire graph. A fixed reference joined to a target, or
hosted/joined targets requiring incompatible shifts, refuses before writing.

### Native Room operations

`room_command` accepts `storey_express_id` and `command` with `query`, `auto`,
`pick`, `footprint`, `update` or `edit`. It uses current native wall/space
geometry and the retained native Room topology; install the WASM runtime.
Supply `model_id` when multiple models are loaded. Each write records one
`mutation_undo` batch including synchronized spaces. Unsupported shapes,
occupied Footprint, read-only access, and ambiguous routing refuse without
partial writes. Preparation refuses stale model state and observes request
cancellation before committing. Session termination and model removal release
the retained native layout handles.

`query_rooms` is available with read-only tokens. It accepts `storey_express_id`,
optional `model_id`, and optional `settings` (`weld`, `minArea`, `boundary`),
and delegates to the same native candidate service without IFC or Undo writes.
Write actions remain protected by `room_command`'s mutation scope. Unchanged
headless storeys reuse prepared geometry; source, overlay or journal changes
invalidate it, and model removal releases the cache.

Cancelled requests return `CANCELLED`; concurrent changes or preparation ownership
return `STATE_CHANGED`, both with `details.retryable: true`. An unavailable native
runtime returns `UNSUPPORTED_OPERATION` with reason `NATIVE_RUNTIME_UNAVAILABLE`.
Malformed commands and unsupported input shapes retain `INVALID_INPUT`.

`propose_flow` lets a read-only MCP caller run a native read/AI-only graph to
a pending artifact. It rejects declared or node-defined effects and permits
only `model.read` and `network.ai`. The current read scope and model allowlist
still apply; the separate `resume_flow` requires current mutate authorization.
MCP responses and checkpoint budgets include provider usage receipts without
prompts, replies or credentials; receipt history survives subsequent pauses.
