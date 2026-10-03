# `@ifc-lite/mcp`

Model Context Protocol (MCP) server for **ifc-lite** — agent-native BIM via JSON-RPC.

> Make ifc-lite the first BIM platform that any LLM agent (Claude Desktop,
> Cursor, ChatGPT, Goose, Windsurf, Zed, custom) can drive directly against
> real models.

## Quick start

```bash
# Run against a local IFC file over stdio (the default for Claude Desktop / Cursor)
npx @ifc-lite/mcp ./model.ifc

# Federate multiple files
npx @ifc-lite/mcp ./arch.ifc ./struct.ifc ./mep.ifc --federate

# Read-only (no mutation tools advertised)
npx @ifc-lite/mcp ./model.ifc --read-only

# HTTP / Streamable HTTP for remote agents
npx @ifc-lite/mcp ./model.ifc --transport http --port 8765 --token $API_TOKEN

# Auto-open the WebGL viewer at startup. Add --open to also pop the URL in
# the system browser.
npx @ifc-lite/mcp ./model.ifc --viewer
npx @ifc-lite/mcp ./model.ifc --open
```

## Embedded loaded-model authoring

`loadIfcModel` returns a model whose `bim.store` supports the existing
`addElementType`, `assignType`, `addMaterial`, `addMaterialLayerSet`,
`addMaterialLayerSetUsage` and `assignMaterial` SDK methods. They delegate to
shared schema-aware builders, convert metre dimensions to native units, and
record each call as one complete public `mutation_undo` operation. Late schema
refusals leave no partial helpers. These embedded methods are distinct from
the JSON-RPC tool names; see the [programmatic embedding guide](https://github.com/LTplus-AG/ifc-lite/blob/main/docs/guide/mcp.md#programmatic-embedding).

`addStair`, `addRailing` and `removeStair` use the same canonical SDK factory.
`removeStair` removes a uniquely owned parent/flight pair atomically, retaining
shared shape/style leaves and refusing ambiguous ownership or foreign product
references. Public `run_flow` routes `element.stair` / `element.railing` through
`model.addElement`; each successful graph creation has one `mutation_undo`.
Tracking is fresh per RPC call, so cross-call update/remove needs a persistent
caller-owned tracking store. No separate creation or Redo RPC is added.

## 3D viewer integration

The server bundles the same WebGL viewer used by `ifc-lite view`. Once it is
open, every viewer-touching tool (`viewer_colorize`, `viewer_isolate`,
`viewer_fly_to`, …) drives the live scene, and any element the user clicks
in the browser flows back to MCP.

### From a chat (the typical flow)

The agent should follow this etiquette by default:

1. Call `viewer_ask` with a `reason`. The tool returns suggested wording so
   the agent can ask the user for permission.
2. After the user agrees, call `viewer_open`. The result includes the URL
   to share with the user.
3. Drive the visualization (`viewer_colorize`, `viewer_color_by_property`,
   `viewer_isolate`, `viewer_fly_to`, `viewer_set_section`).
4. Subscribe to `ifc-lite://viewer/selection` (via `resources/subscribe`)
   to be notified whenever the user picks an element. `viewer_get_selection`
   reads the latest pick directly; `viewer_wait_for_selection` blocks until
   the next click.
5. `viewer_close` when done.

### Pre-baked prompts

- `visual_audit` — opens the viewer, runs `model_audit`, paints issues by
  severity, frames the worst offender.
- `interactive_property_inspect` — opens the viewer, waits for a click,
  then explains everything we know about the picked entity.
- `visualize_query` — runs a query, color-codes matches by property value,
  flies the camera to the result.

You can also reach it via the unified CLI:

```bash
ifc-lite mcp ./model.ifc
ifc-lite mcp ./model.ifc --read-only
```

### Claude Desktop

Drop this into `claude_desktop_config.json`:

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

### Cursor / Windsurf / Goose

The same `npx` command works as a stdio server in any MCP-aware client.

## What the server exposes

| Category | Examples |
| --- | --- |
| Discovery | `model_info`, `model_list`, `model_load`, `model_unload`, `schema_describe` |
| Query | `query_entities`, `count_entities`, `get_entity`, `get_entities_bulk`, `spatial_hierarchy`, `containment_chain`, `relationships`, `properties_unique`, `materials_list`, `classifications_list`, `georeferencing`, `units`, `cost_data`, `cost_evaluate` |
| Geometry | `geometry_bbox`, `geometry_volume`, `geometry_area`, `geometry_get`, `raycast`, `clash_check`, `clash_matrix` |
| Validation | `ids_validate`, `ids_explain`, `model_audit`, `gherkin_check` |
| Mutation | `entity_set_property`, `entity_delete_property`, `entity_set_attribute`, `entity_create`, `entity_delete`, `mutation_batch`, `mutation_undo`, `mutation_diff`, `model_save` |
| Hosted modelling | `place_opening`, `place_door`, `place_window` |
| Design modelling | `place_curtain_wall`, `place_grid`, `place_grid_column` |
| Physical edits | `edit_hosted_element`, `edit_element_geometry`, `copy_elements`, `duplicate_element`, `array_elements` |
| Native Room | `room_command` |
| Wall joins | `join_walls` |
| BCF | `bcf_topic_list`, `bcf_topic_create`, `bcf_topic_update`, `bcf_topic_close`, `bcf_viewpoint_create`, `bcf_export` |
| bSDD | `bsdd_search`, `bsdd_class`, `bsdd_property_sets`, `bsdd_match` |
| Diff | `model_diff` (`by_content` for content-keyed matching), `quantity_diff` |
| Export | `export_ifc`, `export_csv`, `export_json`, `export_glb`, `export_obj`, `export_ifcx`, `export_pdf_report` |
| Viewer | `viewer_ask`, `viewer_open`, `viewer_close`, `viewer_status`, `viewer_colorize`, `viewer_isolate`, `viewer_hide`, `viewer_show`, `viewer_reset`, `viewer_fly_to`, `viewer_set_section`, `viewer_clear_section`, `viewer_color_by_storey`, `viewer_color_by_property`, `viewer_get_selection`, `viewer_wait_for_selection`, `viewer_describe_selection` |

`join_walls` joins two straight walls in the same placement frame through the
viewer/SDK core. It writes `IfcRelConnectsPathElements` and rewrites bodies and
axes atomically. Hosted openings must fit both joined end faces; unreadable cuts
refuse the operation. One `mutation_undo` restores the complete earlier graph,
including replaced profiles, axes and relationships.

`place_opening`, `place_door` and `place_window` use the viewer/SDK's shared
hosted creation core. Pass `host_express_id`, optional `model_id` (required
with several loaded models), and PascalCase `params`: `Offset`, `Width`,
`Height`, optional `Sill` (required for a window). Lengths are metres in the
wall's frame. Cuts must fit and avoid existing source/overlay openings;
unreadable geometry is refused. The void/fill graph is written atomically,
and one `mutation_undo` removes it. These writes reach IFC export; geometry
tools continue to read the parsed model.

`entity_create` accepts an optional `global_id` for the new entity's GlobalId
(IfcRoot subtypes only; written to attribute 0). It must be a valid 22-character
IFC GUID not already carried by an entity in the model; an invalid or duplicate
value is refused with `INVALID_INPUT` and nothing is queued.

`model_diff` compares by GlobalId, which reads a from-scratch re-export as the
whole model deleted and re-added. Pass `by_content: true` to run the
`@ifc-lite/diff` engine's content-keyed matching instead; it is data-scope only
(the server has no geometry pipeline) and reports unresolved `duplicated` /
`deduplicated` / `ambiguous` matches as groups rather than guessing a pairing —
capped by `max_matches` and `max_group_members`, both of which report the whole
totals they cut. A `model_id` names a session rather than a file, so all three
passes fold in mutations queued by `entity_create` / `entity_delete` /
`entity_set_*` and report the count in `contentDiff.pendingMutations`.

The rest of the read surface folds the same overlay: `get_entity`,
`get_entities_bulk`, `query_entities` (property filters and `in_storey` alike),
`count_entities`, `model_info`, `model_list`, `properties_unique`,
`materials_list`, `classifications_list`, `spatial_hierarchy`,
`containment_chain` and `model_audit`, plus the model manifest, entity and
spatial-tree resources. Containment folds too: a wall you create and place with
a queued `IfcRelContainedInSpatialStructure` is found by `in_storey`, and
deleting a relationship record stops it relating anything. Those payloads carry
`pendingMutations` whenever edits are queued and omit the field entirely when
none are, which is the line between "in this session" and "on disk" — nothing is
written until `export_ifc` or `model_save`.

`relationships` (voids/fills/groups/connections), `units`, `georeferencing` and
the geometry, clash and viewer tools answer from the parsed model and say so by
never carrying `pendingMutations`.

One GlobalId resolves to one entity everywhere: an entity the session created
wins over a same-GlobalId entity in the file, and a deleted one never resolves.
`get_entities_bulk` keys its map by that same rule and lists any key that named
more than one live entity in `ambiguousGlobalIds`.

Resources expose live model state under the `ifc-lite://` URI scheme:

```
ifc-lite://server/manifest
ifc-lite://model/{model_id}/manifest
ifc-lite://model/{model_id}/entity/{global_id}
ifc-lite://model/{model_id}/spatial-tree
ifc-lite://model/{model_id}/materials
ifc-lite://model/{model_id}/property-sets
ifc-lite://viewer/status         (open/closed, port, client count)
ifc-lite://viewer/selection      (live; supports `resources/subscribe` for push updates)
```

Pre-baked prompts ship the BIM expertise:

`audit_model`, `find_fire_rated_doors`, `generate_bcf_from_ids`,
`compare_versions`, `space_program_check`, `clash_review`,
`prop_quality_pass`, `migrate_to_ifcx`, `visual_audit`,
`interactive_property_inspect`, `visualize_query`.

## Programmatic embedding

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

For Tauri/Electron hosts, use `InProcessTransport`:

```ts
import { InProcessTransport } from '@ifc-lite/mcp';

const transport = new InProcessTransport();
await transport.connect(server);
const initResp = await transport.send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-05', capabilities: {}, clientInfo: { name: 'host', version: '1' } },
});
```

## Errors

Domain errors come back inside the tool result with `isError: true` and a
stable `structuredContent.code`:

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

That keeps the LLM in the loop instead of aborting the chain on a JSON-RPC
error.

## Roadmap

Shipped: stdio + Streamable HTTP transports; query, geometry (bbox, volume,
area), clash, IDS validation, mutation, BCF, bSDD, diff, export (IFC, CSV, JSON,
GLB, OBJ, IFCX), and live viewer control.

Planned: mesh geometry (`geometry_get`) and `raycast` (both need the WASM
geometry pipeline), Gherkin validation (`gherkin_check`), and PDF report export
(`export_pdf_report`) — these tools are registered but currently return
`UNSUPPORTED_OPERATION`. Also planned: OAuth 2.1 with PKCE and hosted
multi-tenant deployment, sampling for natural-language descriptions, and public
registry listing.

## Docs

See the [ifc-lite docs](https://ifclite.dev/docs/) for the full
platform documentation.

Licensed under MPL-2.0.

Loaded-model physical edits use the same command cores as the viewer and typed
SDK. `edit_element_geometry` handles Move/Rotate, Size, Wall Endpoints, Split and
Trim/Extend. `copy_elements`, `duplicate_element` and `array_elements` carry
hosted graph records and share the viewer placement and naming policies.
References are model-local EXPRESS IDs; offsets use IFC storey-local metres
and planar rotations use radians. Every write is one `mutation_undo` batch;
unsupported sources and unsafe shared geometry refuse before committing.
See the [MCP guide](https://github.com/LTplus-AG/ifc-lite/blob/main/docs/guide/mcp.md)
for parameter contracts.

`room_command` derives Room candidates from the current native geometry and
runs Auto/Pick/Footprint/Update or layout Drag/Split/Remove/Prune through the
shared Room core. It requires the WASM runtime. Query does not write; writes
record one complete Undo batch. Model removal and session termination free
retained native layout handles.
