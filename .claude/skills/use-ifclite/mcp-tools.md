# ifc-lite as an MCP server

`@ifc-lite/mcp` exposes ifc-lite as an agent-native Model Context Protocol
server (stdio + Streamable HTTP). Use this when an MCP-capable agent should
call BIM operations as typed tools instead of shelling out to the CLI.

## Launching

```bash
ifc-lite mcp ./model.ifc                       # stdio (default transport)
ifc-lite mcp ./model.ifc --read-only           # hide all mutation tools
ifc-lite mcp ./arch.ifc ./struct.ifc --federate
ifc-lite mcp --transport http --port 8765 --token <secret>
ifc-lite mcp ./model.ifc --viewer              # auto-open the 3D viewer
```

The standalone binary `ifc-lite-mcp …` accepts the same flags. Useful options:
`--read-only`, `--federate`, `--transport stdio|http`, `--port`, `--host`
(loopback by default; non-loopback needs `--token` or `--insecure`), `--token`
(a single bearer token for HTTP auth; combine with `--read-only` to scope the
whole server read-only), `--bsdd <url>`, `--allow <path>` (restrict filesystem
access).

Register it with Claude Code via your MCP config, e.g.:

```json
{
  "mcpServers": {
    "ifc-lite": { "command": "ifc-lite", "args": ["mcp", "./model.ifc", "--read-only"] }
  }
}
```

## Calling pattern: discovery first

The read-only discovery tools are always on — call them before anything else:

1. `model_list` / `model_info` — what's loaded, schema, counts, units, georeferencing.
2. `schema_describe` — entity metadata, inheritance chains, attribute shapes.
3. Then query / validate / mutate / export as needed.

## Tool families (~70 tools)

**Models** — `model_info`, `model_list`, `model_load`, `model_unload`,
`model_save`, `model_audit`, `model_diff`.

**Discovery & metadata** — `schema_describe`, `units`, `georeferencing`,
`classifications_list`, `materials_list`, `spatial_hierarchy`,
`containment_chain`, `relationships`.

**Query** — `query_entities`, `count_entities`, `get_entity`,
`get_entities_bulk`, `properties_unique`, `quantity_diff`.

**Geometry** — `geometry_get`, `geometry_bbox`, `geometry_area`,
`geometry_volume`, `raycast`.

**Validation** — `ids_validate`, `ids_explain`, `gherkin_check`.

**Clash** — `clash_check`, `clash_matrix`.

**bSDD** — `bsdd_search`, `bsdd_class`, `bsdd_match`, `bsdd_property_sets`.

**Mutations** (hidden under `--read-only`) — `entity_create`, `entity_delete`,
`entity_set_attribute`, `entity_set_property`, `entity_delete_property`,
`mutation_batch`, `mutation_diff`, `mutation_undo`.

**Export** — `export_csv`, `export_json`, `export_ifc`, `export_ifcx`,
`export_glb`, `export_pdf_report`.

**BCF** — `bcf_topic_create`, `bcf_topic_update`, `bcf_topic_close`,
`bcf_topic_list`, `bcf_viewpoint_create`, `bcf_export`.

**Viewer** (interactive 3D, when launched with `--viewer`) — `viewer_open`,
`viewer_close`, `viewer_status`, `viewer_colorize`, `viewer_color_by_property`,
`viewer_color_by_storey`, `viewer_isolate`, `viewer_hide`, `viewer_show`,
`viewer_fly_to`, `viewer_set_section`, `viewer_clear_section`, `viewer_reset`,
`viewer_get_selection`, `viewer_wait_for_selection`, `viewer_describe_selection`,
`viewer_ask`.

## Pre-baked prompts

The server ships prompt templates that package a BIM-expert intent plus the
right tool sequence, e.g. `audit_model`, `find_fire_rated_doors`,
`generate_bcf_from_ids`, `compare_versions`, `space_program_check`. Surface
these to the user as one-click starting points where the host supports MCP
prompts.

## Same correctness rules as the CLI

Exact IFC EXPRESS names, PascalCase attributes, full relationship entity names,
and federation-aware ID resolution all apply identically — see the main
`SKILL.md`.
