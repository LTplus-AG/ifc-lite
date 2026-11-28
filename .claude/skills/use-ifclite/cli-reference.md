# ifc-lite CLI — full command reference

Headless BIM toolkit. Many commands offer machine-readable output through `--json`.
For tabular JSON from `export` or `schedule`, use `--format json`. `gym` speaks a
newline-delimited JSON protocol. **stdout = data, stderr = status.** Most commands
exit 0 on success and 1 on failure; some (for example `flow`) have more codes. Run
`ifc-lite <command> --help` for the live signature, and `ifc-lite schema` for
the full SDK API used by `eval`/`run`.

| Command | Purpose |
|---------|---------|
| `doctor` | Check CLI runtime, package versions and WASM binary |
| `info` | Model summary: schema, entity counts, storeys, top types |
| `query` | Query entities by type/property with optional full data |
| `structural` | Read analysis models, members, connections, loads, reactions and physical links |
| `props` | All data for a single entity by id |
| `export` | Export data / geometry / energy / city model (CSV, JSON, IFC, OBJ, glTF/GLB, JSON-LD, IFCX, USD, 3DM, HBJSON, DFJSON, CityJSON) |
| `schedule` | Tabular schedule of one class (csv/json/md/html), with presets, sorting, grouping and subtotals |
| `diagnose-geometry` | CSG / opening diagnostics |
| `extract-entities` | Isolate entities into a small, viewable standalone IFC |
| `anonymize` | Export selected objects + context as an anonymized IFC |
| `ids` | Validate against IDS rules; `audit`, `lint`, `fmt`, `diff`, `explain` IDS files |
| `bcf` | BCF collaboration (create / list / add-comment) |
| `clash` | Clash detection between element sets |
| `create` | Create IFC elements (29 types) |
| `eval` | Evaluate a JS SDK expression |
| `run` | Run a JS script with `bim` in scope |
| `schema` | Dump the SDK API schema as JSON |
| `merge` | Merge multiple IFC files into one federated model |
| `convert` | Convert between IFC schema versions |
| `diff` | Compare two IFC files (by GlobalId, by content, with geometry) |
| `rekey` | Carry a table keyed on old element keys across a revision |
| `validate` | Structural validation |
| `bsdd` | buildingSMART Data Dictionary lookup |
| `stats` | Auto-calculated model KPIs and health check |
| `mutate` | Modify properties/attributes and save |
| `generate-spaces` | Derive IfcSpace from walls |
| `derive-structural` | Derive a linked structural analysis model |
| `storey` | Author storeys (list / add / rename / edit / delete / constrain / copy) |
| `georef` | Read, write, check and fix georeferencing |
| `site-context` | Swiss terrain, parcel and neighbouring buildings around a georeferenced model as one GLB |
| `ask` | Natural-language recipe engine |
| `view` | Launch the 3D viewer with a REST API |
| `analyze` | Push color overlays to a running viewer |
| `lod` | Lightweight LOD0 (JSON) / LOD1 (GLB) preview artifacts |
| `simplify` | Simplify meshes and write a lighter IFC |
| `mcp` | Start an MCP server; `mcp install` adds it to a client config |
| `ext` | Author / validate / pack / sign / test IFClite extensions |
| `layer` / `ref` | Layered change tracking and named refs over a local store (`.ifc-lite/`) |
| `oci` | Publish an IFC file to an OCI registry (`oci push`) |
| `gym` | reset/step/reward environment loop (JSONL over stdin/stdout) |
| `delivery` | Repeatable delivery check from a saved recipe |
| `check` | Run a `.rules.json` information-validation rule set |
| `semantic` | Semantic profiles, SHACL validation and SPARQL/JSON providers |
| `flow` | Evaluate a node graph headlessly; pause and resume reviewed AI proposals |

## query

```bash
ifc-lite query model.ifc --type IfcWall,IfcDoor --json
ifc-lite query model.ifc --type IfcWall --where "Pset_WallCommon.IsExternal=true"
ifc-lite query model.ifc --type IfcWall --all --json
ifc-lite query model.ifc --type IfcWall --limit 10 --offset 20
ifc-lite query model.ifc --spatial            # storeys → elements tree
```

Flags: `--type <T>` · `--select "<selector>"` · `--where <Pset.Prop=Value>` ·
`--storey <S>` · `--props` · `--quantities` · `--materials` · `--classifications` ·
`--attributes` · `--relationships` · `--type-props` · `--documents` · `--all` ·
`--count` · `--spatial` · `--summary` · `--sum/--avg/--min/--max <Qty>` ·
`--group-by <key>` · `--sort <key>` · `--desc` · `--unique <path>` ·
`--property-names` · `--quantity-names` · `--limit <N>` · `--offset <N>` · `--json`

## props

```bash
ifc-lite props model.ifc --id 42
```

Returns `attributes`, `properties`, `quantities`, `classifications`,
`materials`, `typeProperties`, `relationships`.

## export

```bash
ifc-lite export model.ifc --format csv --type IfcWall \
  --columns Name,Type,Pset_WallCommon.IsExternal,Pset_WallCommon.FireRating --out walls.csv
ifc-lite export model.ifc --format ifc --schema IFC4 --out filtered.ifc
```

Flags: `--format csv|json|ifc|obj|gltf|glb|jsonld|step|ifcx|usd|3dm|hbjson|dfjson|cityjson|cityjsonseq` ·
`--type <T>` · `--where <Pset.Prop=Value>` · `--storey <S>` · `--columns <a,b,Pset.Prop>` ·
`--separator <sep>` · `--schema IFC2X3|IFC4|IFC4X3` · `--limit <N>` · `--name <Model>` ·
`--name-by-global-id` (glb/gltf) · `--out <file>`. 3DM adds `--units`, `--coordinates`,
`--layers`, `--properties`, `--3dm-version 7|8`, `--no-instancing`, `--no-spaces`,
`--no-normals`, `--layer-slicing`. CityJSON adds `--scale STEP` (vertex grid,
default 0.001) and `--blocks-only`. Experimental `--kernel exact|retained` defaults to `exact`.
Retained export requires `--format obj` and an engine directory from `--retained-engine DIR`
or `IFCLITE_RETAINED_ENGINE`; `--retained-report FILE` writes an optional report.

`ifcx`, `usd`, `hbjson`, `dfjson`, `cityjson` and `cityjsonseq` always export
the whole model: they ignore `--type`, `--where`, `--storey` and `--limit`.
`glb` and `gltf` both write binary GLB and require `--out`.

(For Parquet export use the SDK `@ifc-lite/export` package or `eval`.)

## schedule

```bash
ifc-lite schedule model.ifc --preset door --format md
ifc-lite schedule model.ifc --type IfcDoor --columns "Name=Name, Fire=Pset_DoorCommon.FireRating, Area=Qto_DoorBaseQuantities.Area" \
  --group-by Fire --sort "Area:desc" --subtotals "count, sum:Area"
ifc-lite schedule model.ifc --preset door --save door-schedule.json
ifc-lite schedule model.ifc --spec door-schedule.json --format json
```

Flags: `--type <T>` · `--columns "Header=path,..."` (path = attribute, `Pset.Prop`
or `Qto.Qty`) · `--preset door|window|space|wall|material-takeoff` ·
`--where <Pset.Prop=Value>` · `--format csv|json|md|html` · `--sort "Header[:asc|desc],..."` ·
`--group-by "Header,..."` · `--subtotals "count|sum:H|avg:H|min:H|max:H,..."` ·
`--spec <file>` / `--save <file>` (an explicit flag beats `--spec`, which beats `--preset`).

## lod

```bash
ifc-lite lod model.ifc --level 0 --out model.lod0.json
ifc-lite lod model.ifc --level 1 --out model.glb --meta model.lod1.json
```

Flags: `--level 0|1` · `--out <file>` (required for LOD1) · `--meta <file>` ·
`--json`. LOD0 = bbox/transform/centroid/identity
JSON; LOD1 = GLB + metadata (falls back to box geometry if meshing fails).

## ids

```bash
ifc-lite ids model.ifc requirements.ids --json --locale de
```

Flags: `--json` · `--locale en|de|fr`. Exit 0 (pass) / 1 (fail).

IDS file tools (exit 2 on a usage error or unreadable input):

```bash
ifc-lite ids audit rules.ids --json        # IDS 1.0 conformance audit (exit 1 on errors)
ifc-lite ids lint rules.ids --fail-on warning
ifc-lite ids fmt rules.ids --check         # exit 1 when the file would change; --write rewrites it
ifc-lite ids diff before.ids after.ids --md
ifc-lite ids explain rules.ids --lang de --md
```

## bcf

```bash
ifc-lite bcf create --title "Missing fire door" --description "Level 2" --out topic.bcf
ifc-lite bcf list topics.bcf
ifc-lite bcf add-comment --file topics.bcf --text "Fixed in rev 3" --out updated.bcf
```

## create

29 element types, with `--pset` / `--qset` / `--material` / `--color`, or
`--from-json` (reads stdin). Pass `--out <file>`, `--viewer <port>` (stream into
a running `ifc-lite view`), or both; viewer-only fails if the stream fails.

| Category | Types |
|----------|-------|
| Walls | `wall`, `curtain-wall` |
| Floors/Roofs | `slab`, `roof`, `gable-roof` |
| Columns | `column`, `circular-column`, `hollow-circular-column` |
| Beams | `beam`, `i-shape-beam`, `rectangle-hollow-beam` |
| Members | `member`, `l-shape-member`, `t-shape-member`, `u-shape-member` |
| Openings | `door`, `window`, `wall-door`, `wall-window` |
| Circulation | `stair`, `ramp`, `railing` |
| Foundation | `footing`, `pile` |
| Other | `space`, `plate`, `furnishing`, `proxy`, `storey` |

```bash
ifc-lite create wall --start 0,0,0 --end 5,0,0 --height 3 --thickness 0.2 --out wall.ifc
ifc-lite create slab --width 10 --depth 8 --thickness 0.3 --out slab.ifc
ifc-lite create wall --out w.ifc \
  --pset '{"Name":"Pset_WallCommon","Properties":[{"Name":"IsExternal","NominalValue":true}]}'
echo '{"Start":[0,0,0],"End":[10,0,0],"Height":3,"Thickness":0.2}' | ifc-lite create wall --from-json --out wall.ifc
```

Common flags: `--start/--end/--position <x,y,z>` · `--height/--width/--depth/--thickness <N>` ·
`--name` · `--project` · `--storey` · `--elevation` · `--pset/--qset/--material <json>` ·
`--color <r,g,b>` · `--from-json` · `--out <file>` · `--viewer <port>` · `--json`. Coordinates are IFC **Z-up**.

## merge / convert / diff / validate

```bash
ifc-lite merge arch.ifc struct.ifc --out federated.ifc --json   # unifies storeys by name+elevation, offsets ids
ifc-lite convert model.ifc --schema IFC4 --out v4.ifc           # IFC2X3|IFC4|IFC4X3|IFC5
ifc-lite diff v1.ifc v2.ifc --by-entity --json                  # GlobalId-based entity tracking
ifc-lite validate model.ifc --json                              # required entities, single IfcProject, GlobalId uniqueness
```

## bsdd

```bash
ifc-lite bsdd class IfcWall        # definition, related types, properties
ifc-lite bsdd search "concrete wall"
ifc-lite bsdd psets IfcWall        # standard property sets
ifc-lite bsdd qsets IfcSlab        # standard quantity sets
```

## georef

```bash
ifc-lite georef show model.ifc --json        # IfcMapConversion/IfcProjectedCRS (IFC2X3: ePSet_MapConversion)
ifc-lite georef set model.ifc --epsg 2056 --map-unit METRE \
  --eastings 2600000 --northings 1200000 --height 400 --rotation 12.5 --out geo.ifc
ifc-lite georef update geo.ifc --height 401 --out geo2.ifc
ifc-lite georef remove geo.ifc --out plain.ifc
ifc-lite georef check model.ifc --json        # findings with codes + fix plan; exit 1 on errors (--fail-on)
ifc-lite georef fix model.ifc --out fixed.ifc # applies only `ready` fixes, re-checks the written file
ifc-lite georef fix model.ifc --out fixed.ifc --value ProjectedCRS.Name=EPSG:2056 --apply EASTING_ZONE_PREFIX.2
```

Fails closed (exit 1, nothing written): a missing CRS/unit/offset, an existing
georeferencing without `--replace`, no representation context (IFC2X3: no
IfcSite), contradicting rotation values, factors outside FILE_SCHEMA IFC4X3 / IFC4X3_ADD2. Every write is
re-read from the written bytes before it is saved. `info --json` carries the
same `georeferencing` object. `check`/`fix` run offline unless `--allow-network`;
fixes that need a value list the `--value PATH=V` to pass, and a fix the checker marks
uncertain (`review`) is never applied.

## eval / run / schema

```bash
ifc-lite eval model.ifc "bim.query().byType('IfcDoor').toArray().filter(d => d.name.includes('Fire'))"
ifc-lite run analysis.js model.ifc          # `bim` is global in the script
ifc-lite schema            # full API JSON (namespaces: bim, query, model, viewer, mutate, store, create, export, clash, schedule, ...)
ifc-lite schema --compact  # names + descriptions only
```

`eval` is the most flexible tool — arbitrary SDK code without a dedicated
subcommand. Always run `ifc-lite schema` first to learn method names/params.

## view / analyze (3D viewer)

```bash
ifc-lite view model.ifc --port 3456 --no-open       # serves a REST API: /api/command, /api/create, /api/export, /api/status
ifc-lite analyze model.ifc --viewer 3456 --type IfcWall --missing "Pset_WallCommon.FireRating" --color red --isolate --flyto
```

`analyze` supports `--where`, `--missing`, `--heatmap <Pset.Prop>`,
`--palette blue-red|green-red|rainbow`, `--rules <file>`. See the viewer-api
guide for the full REST surface.

## flow

```bash
ifc-lite flow describe graph.flow.json      # inputs (nodeId.param keys) and outputs
ifc-lite flow validate graph.flow.json
ifc-lite flow run graph.flow.json model.ifc --input filter.threshold=3 --out paused.ifc --checkpoint review.json
# Copy the proposal digest printed by the paused run into PROPOSAL_DIGEST.
ifc-lite flow review review.json --approve "${PROPOSAL_DIGEST:?Set PROPOSAL_DIGEST to the printed proposal digest}"   # or --reject
ifc-lite flow resume graph.flow.json paused.ifc --input filter.threshold=3 --checkpoint review.json --out result.ifc
```

Pass `--checkpoint` before running a graph with a review node. Resume requires that
checkpoint, the paused IFC and the same input overrides, plus `--next-checkpoint` if
another review node remains. `flow bcf list` and `check` inspect durable BCF publication
entries; `reconcile` and `confirm-absent` update their local records. See
`ifc-lite flow --help`.

## Pipe patterns

```bash
ifc-lite query model.ifc --type IfcDoor --json | jq -r '.[].name'
for f in *.ifc; do echo "$f: $(ifc-lite query "$f" --type IfcWall --count) walls"; done
ifc-lite merge arch.ifc struct.ifc --out fed.ifc && ifc-lite validate fed.ifc
ifc-lite bsdd psets IfcWall --json | jq '.["Pset_WallCommon"]'
```
