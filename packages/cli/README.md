# @ifc-lite/cli

BIM toolkit for the terminal. The `ifc-lite` command reads, queries, validates, exports, creates, merges, converts, and diffs IFC files, and can script them with the `bim.*` SDK. Output is pipe-friendly and every command supports `--json` for machine-readable results, which makes it a good fit for both humans and LLM terminals.

## Install

```bash
npm install -g @ifc-lite/cli
```

## Usage

```bash
ifc-lite info model.ifc
ifc-lite query model.ifc --type IfcWall --json
ifc-lite props model.ifc --id 42
ifc-lite export model.ifc --format csv --type IfcWall --columns Name,Type,GlobalId
ifc-lite create wall --height 3 --thickness 0.2 --start 0,0,0 --end 5,0,0 --out wall.ifc
ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"
ifc-lite view model.ifc
```

## Commands

- `info` - model summary: schema, entities, storeys
- `query` - query entities by type, properties, quantities; supports `--sum`, `--group-by`, `--spatial`
- `props` - all properties for a single entity (`--id N`)
- `export` - export to `csv`, `json`, `ifc`, or `hbjson`
- `ids` - validate against buildingSMART IDS rules
- `validate` - structural validation checks
- `stats` - auto-calculated model KPIs and health check
- `clash` - geometric clash detection, `--matrix`, `--bcf` output
- `bcf` - create and inspect BCF collaboration files
- `create` - create IFC elements from scratch (walls, slabs, stairs, 30+ types)
- `mutate` - modify properties or attributes and save
- `merge` - merge multiple IFC files into one federated file
- `convert` - convert between IFC schema versions (`--schema IFC4`)
- `diff` - compare two IFC files
- `eval` / `run` - run SDK expressions or scripts against a model
- `ask` - natural language BIM queries
- `view` - interactive 3D viewer in the browser, controllable via REST (`/api/command`)
- `analyze` - query plus colorize/isolate/heatmap results in the running viewer
- `mcp` - start an MCP server bound to one or more IFC files (stdio or http)
- `gym` - reset/step/reward environment loop over the existing schema/clash/ids checks (see below)
- `schema`, `bsdd`, `diagnose-geometry`, `extract-entities`, `generate-spaces`, `lod`, `ext` - see `ifc-lite --help`

Global flags: `--json`, `--out <file>`, `--verbose`, `--quiet`, `--debug`, `--log-level <level>`.

## gym

`ifc-lite gym` is a prototype reset/step/reward environment API over the existing headless checks: the skeleton of an RLVR environment for buildings (see [`docs/vision/moonshots-tech.md`](../../docs/vision/moonshots-tech.md) M2 and [`docs/vision/moonshots-execution-plan.md`](../../docs/vision/moonshots-execution-plan.md) B0.4). It wraps ONE loaded model (there is no procedural generator yet) and lets an agent apply data-mutation ops, scoring each step against the same schema/clash/ids checks the `validate`, `clash`, and `ids` commands already run.

```bash
ifc-lite gym --model model.ifc --checks schema,clash
ifc-lite gym --model model.ifc --checks schema,clash,ids --ids rules.ids
```

The protocol is newline-delimited JSON: one JSON object per line, in both directions.

- On start, `gym` prints one line: `{"type":"reset","observation":{...},"channels":{...}}`. `observation` has sorted `entityCounts` (by IFC type), `storeyCount`, and `schema` version. `bounds` is always `null` in v0 (a known gap: no geometry pass runs on `reset`, see below).
- Send `{"type":"step","ops":[...]}` on stdin to apply ops and score the result. `gym` replies `{"type":"reward","channels":{...},"done":false}`.
- Send `{"type":"reset"}` to reload the pristine model; replies like the initial reset.
- Send `{"type":"close"}` to exit 0.
- Malformed JSON or an unknown command/op never crashes the process: it replies `{"type":"error","message":"..."}` and keeps reading.

v0 ops mirror `bim.mutate`'s method names exactly: `setProperty`, `setAttribute`, `deleteProperty` (all keyed by `expressId`). Geometry-creating ops (new walls, slabs, etc.) are out of scope for v0.

```
{"type":"step","ops":[{"op":"setProperty","expressId":42,"psetName":"Pset_WallCommon","propName":"IsExternal","value":true}]}
```

Determinism: the same model plus the same op sequence yields byte-identical reward lines (sorted arrays, no timestamps, fixed-precision floats).

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
