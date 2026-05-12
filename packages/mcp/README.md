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
| Query | `query_entities`, `count_entities`, `get_entity`, `get_entities_bulk`, `spatial_hierarchy`, `containment_chain`, `relationships`, `properties_unique`, `materials_list`, `classifications_list`, `georeferencing`, `units` |
| Geometry | `geometry_bbox`, `geometry_volume`, `geometry_area` (mesh/raycast/clash require WASM, planned v0.2) |
| Validation | `ids_validate`, `ids_explain`, `model_audit`, `gherkin_check` (v0.2) |
| Mutation | `entity_set_property`, `entity_delete_property`, `entity_set_attribute`, `entity_create`, `entity_delete`, `mutation_batch`, `mutation_undo`, `mutation_diff`, `model_save` |
| BCF | `bcf_topic_list`, `bcf_topic_create`, `bcf_topic_update`, `bcf_topic_close`, `bcf_viewpoint_create`, `bcf_export` |
| bSDD | `bsdd_search`, `bsdd_class`, `bsdd_property_sets`, `bsdd_match` |
| Diff | `model_diff`, `quantity_diff` |
| Export | `export_ifc`, `export_csv`, `export_json`, `export_glb` (v0.2), `export_ifcx` (v0.2), `export_pdf_report` (v0.5) |
| Viewer | `viewer_ask`, `viewer_open`, `viewer_close`, `viewer_status`, `viewer_colorize`, `viewer_isolate`, `viewer_hide`, `viewer_show`, `viewer_reset`, `viewer_fly_to`, `viewer_set_section`, `viewer_clear_section`, `viewer_color_by_storey`, `viewer_color_by_property`, `viewer_get_selection`, `viewer_wait_for_selection` |

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

| Version | Adds |
| --- | --- |
| 0.1 | stdio + Streamable HTTP, query / IDS / mutate / BCF / bSDD / diff / viewer |
| 0.2 | WASM geometry (mesh, raycast, clash), gherkin validation, IFCX export |
| 0.3 | OAuth 2.1 with PKCE, hosted multi-tenant deployment |
| 0.5 | Sampling for natural-language descriptions, two-way viewer editing |
| 1.0 | Public registry listing, full spec coverage |

Licensed under MPL-2.0.
