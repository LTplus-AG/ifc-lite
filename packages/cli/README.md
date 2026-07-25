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

`ifc-lite gym` is a prototype reset/step/reward environment API over the existing headless checks: the skeleton of an RLVR environment for buildings (see [`docs/vision/moonshots-tech.md`](../../docs/vision/moonshots-tech.md) M2 and [`docs/vision/moonshots-execution-plan.md`](../../docs/vision/moonshots-execution-plan.md) B0.4). It wraps a model - either a fixed file (`--model`) or a procedurally generated World Gym episode (`--seed`) - and lets an agent apply data-mutation ops, scoring each step against the same schema/clash/ids checks the `validate`, `clash`, and `ids` commands already run.

```bash
ifc-lite gym --model model.ifc --checks schema,clash
ifc-lite gym --model model.ifc --checks schema,clash,ids --ids rules.ids
ifc-lite gym --seed 42 --checks schema,clash          # generated episode (repo checkout only)
ifc-lite gym --seed 8 --family frame --corrupt --checks schema
```

The protocol is newline-delimited JSON: one JSON object per line, in both directions.

- On start, `gym` prints one line: `{"type":"reset","observation":{...},"channels":{...}}`. `observation` has sorted `entityCounts` (by IFC type), `storeyCount`, and `schema` version. `bounds` is always `null` in v0 (a known gap: no geometry pass runs on `reset`, see below). Generated episodes add an `episode` field: `{seed, family, corrupted}`.
- Send `{"type":"step","ops":[...]}` on stdin to apply ops and score the result. `gym` replies `{"type":"reward","channels":{...},"done":false}`. A step batch is atomic: it either fully applies or (on any malformed op or scoring failure) leaves the session unchanged and replies with an error line.
- Send `{"type":"reset"}` to reload the pristine model; replies like the initial reset.
- Send `{"type":"reset","seed":8}` (optional `family`, `corrupt` OR `corruptRate`) to swap to a fresh generated episode mid-session.
- Send `{"type":"close"}` to exit 0.
- Malformed JSON or an unknown command/op never crashes the process: it replies `{"type":"error","message":"..."}` and keeps reading.

Episode factory: `--seed <n>` generates a deterministic World Gym benchmark model in-process instead of loading a file. `--family frame|office|auto` pins the family; corruption follows the benchmark's deterministic draw at the spec's corrupt rate unless `--corrupt`/`--no-corrupt` forces it or `--corrupt-rate <p>` overrides the rate (forcing and a rate are mutually exclusive). The generator is dynamically imported from a repo checkout (`tools/world-gym/`); the published npm package prints a clear error for `--seed` while `--model` keeps working.

Reward shaping: every channel's `score` is in `[0, 1]` and higher is better. The clash channel scores `1` for a clash-free model and strictly decreases as the clash count grows (the raw count is reported separately as `totalClashes`), so an agent maximizing any channel is never rewarded for making the model worse.

v0 ops mirror `bim.mutate`'s method names exactly: `setProperty`, `setAttribute`, `deleteProperty` (all keyed by `expressId`). Geometry-creating ops (new walls, slabs, etc.) are out of scope for v0.

```json
{"type":"step","ops":[{"op":"setProperty","expressId":42,"psetName":"Pset_WallCommon","propName":"IsExternal","value":true}]}
```

Determinism: the same model plus the same op sequence yields byte-identical reward lines (sorted arrays, no timestamps, fixed-precision floats).

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
