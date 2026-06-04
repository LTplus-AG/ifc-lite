---
name: use-ifclite
description: >-
  Work with IFC / BIM files (.ifc, .ifcx, IFC2X3 / IFC4 / IFC4X3 / IFC5) from the
  terminal using the ifc-lite CLI — inspect, query, validate (IDS), export
  (CSV/JSON/IFC/glTF/Parquet), create elements, merge, convert schema versions,
  diff, clash-check, run BCF collaboration, and script the SDK. Use whenever a
  task involves reading, analysing, generating, or editing IFC building models,
  or when the user mentions IFC, BIM, BCF, IDS, or buildingSMART. Also covers
  running ifc-lite as an MCP server for tool-calling agents.
---

# Using ifc-lite

`ifc-lite` is a headless BIM toolkit for IFC files. It was built for LLM
terminals: every command takes `--json`, **stdout is data, stderr is status**,
and exit `0`/`1` means pass/fail. Prefer it over hand-parsing IFC text.

## Start here (every session)

```bash
ifc-lite --help            # all commands
ifc-lite schema            # full SDK API as JSON (namespaces, methods, params) — read before writing eval/run code
ifc-lite info model.ifc --json   # schema version, entity counts, storeys, top types
```

If `ifc-lite` isn't installed, run via `npx @ifc-lite/cli <command>` or install
with `npm install -g @ifc-lite/cli`.

## Core workflows

```bash
# Query entities (use exact IFC type names; comma-separated for multiple)
ifc-lite query model.ifc --type IfcWall --json
ifc-lite query model.ifc --type IfcWall --where "Pset_WallCommon.IsExternal=true" --json
ifc-lite query model.ifc --type IfcWall --all --json    # props, quantities, materials, classifications, relationships
ifc-lite query model.ifc --type IfcDoor --count

# Inspect one entity fully
ifc-lite props model.ifc --id 42

# Export
ifc-lite export model.ifc --format csv --type IfcWall --columns Name,GlobalId,Pset_WallCommon.FireRating --out walls.csv
ifc-lite export model.ifc --format ifc --schema IFC4 --out filtered.ifc

# Validate against IDS rules (exit 1 on failure)
ifc-lite ids model.ifc requirements.ids --json

# Create IFC from scratch (30+ element types)
ifc-lite create wall --start 0,0,0 --end 5,0,0 --height 3 --thickness 0.2 --out wall.ifc

# Combine / convert / compare
ifc-lite merge arch.ifc struct.ifc mep.ifc --out federated.ifc
ifc-lite convert model.ifc --schema IFC4 --out v4.ifc
ifc-lite diff v1.ifc v2.ifc --by-entity --json

# Structural sanity check
ifc-lite validate model.ifc --json
```

## The power tools: `eval` and `run`

When no flag fits, drop into the full SDK. The `bim` object is the entire
`@ifc-lite/sdk` surface (discover it with `ifc-lite schema`).

```bash
ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"
ifc-lite eval model.ifc "bim.storeys().map(s => s.name)"
ifc-lite run analysis.js model.ifc           # a .js file with `bim` available globally
```

`ifc-lite ask model.ifc "how many walls?"` maps plain-English questions to common
recipes — handy for quick one-offs, but `eval` is more precise.

For the **complete command + flag reference** (every command, all flags, the 30+
`create` element types, `bsdd`, `clash`, `lod`, `view`/`analyze`), read
[`cli-reference.md`](./cli-reference.md).

## Rules that keep IFC output correct

These are non-negotiable when emitting IFC names or editing models:

- **Exact IFC EXPRESS names, never aliases.** Types like `IfcWallStandardCase`,
  relationships like `IfcRelAggregates` (not `Aggregates`). Attributes in IFC
  PascalCase: `GlobalId`, `Name`, `Description`, `ObjectType`.
- **STEP type names are stored UPPERCASE.** Don't hand-case them — query
  results already carry the resolved IFC type in `EntityData.type` (e.g.
  `entity.type === 'IfcWall'`), so read that instead of reconstructing it.
- **Single vs federated models are both first-class.** When multiple files are
  merged/federated, IDs are namespaced; resolve through the federation registry
  rather than assuming `globalId === expressId`. (Single-model fallback: they're
  equal.)
- **`--where` filters** use `PsetName.PropName=Value` (e.g.
  `Pset_WallCommon.IsExternal=true`).
- **Coordinates are IFC Z-up** `[x, y, z]` when creating elements.

## Tips for agent use

1. Always pass `--json`; pipe to `jq` for filtering.
2. Run `ifc-lite schema` before writing `eval`/`run` code.
3. Use `--count` for quick counts; `--all` to get full entity data in one call.
4. Use `create --from-json` (reads stdin) for programmatic generation.
5. Don't loop calling per-entity extraction; fetch in bulk with `query --all`.

## Running as an MCP server (tool-calling agents)

For agents that speak the Model Context Protocol, `@ifc-lite/mcp` exposes the
same capabilities as ~70 typed tools (model/query/IDS/BCF/clash/export/viewer/
mutation) plus pre-baked prompts.

```bash
ifc-lite mcp ./model.ifc                 # stdio transport (default)
ifc-lite mcp ./model.ifc --read-only     # hide all mutation tools
ifc-lite mcp ./arch.ifc ./struct.ifc --federate
ifc-lite mcp --transport http --port 8765 --token <secret>
# (equivalent standalone binary: ifc-lite-mcp …)
```

Tool families and the discovery-first calling pattern are documented in
[`mcp-tools.md`](./mcp-tools.md).
