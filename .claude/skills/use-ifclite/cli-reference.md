# ifc-lite CLI — full command reference

Headless BIM toolkit. Every command supports `--json` (machine-readable).
**stdout = data, stderr = status, exit 0 = success / 1 = failure.** Run
`ifc-lite <command> --help` for the live signature, and `ifc-lite schema` for
the full SDK API used by `eval`/`run`.

| Command | Purpose |
|---------|---------|
| `info` | Model summary: schema, entity counts, storeys, top types |
| `query` | Query entities by type/property with optional full data |
| `props` | All data for a single entity by id |
| `stats` | Entity-type statistics |
| `export` | Export to CSV / JSON / IFC STEP |
| `lod` | Lightweight LOD0 (JSON) / LOD1 (GLB) preview artifacts |
| `ids` | Validate against IDS rules |
| `bcf` | BCF collaboration (create / list / add-comment) |
| `create` | Create IFC elements (30+ types) |
| `merge` | Merge multiple IFC files into one federated model |
| `convert` | Convert between IFC schema versions |
| `diff` | Compare two IFC files |
| `validate` | Structural validation |
| `clash` | Clash detection between element sets |
| `bsdd` | buildingSMART Data Dictionary lookup |
| `mutate` | Modify entities / properties |
| `analyze` | Push color overlays to a running viewer |
| `view` | Launch the 3D viewer with a REST API |
| `eval` | Evaluate a JS SDK expression |
| `run` | Run a JS script with `bim` in scope |
| `ask` | Natural-language recipe engine |
| `schema` | Dump the SDK API schema as JSON |
| `ext` | Author / validate / pack / sign / test IFClite extensions |

## query

```bash
ifc-lite query model.ifc --type IfcWall,IfcDoor --json
ifc-lite query model.ifc --type IfcWall --where "Pset_WallCommon.IsExternal=true"
ifc-lite query model.ifc --type IfcWall --all --json
ifc-lite query model.ifc --type IfcWall --limit 10 --offset 20
ifc-lite query model.ifc --spatial            # storeys → elements tree
```

Flags: `--type <T>` · `--where <Pset.Prop=Value>` · `--props` · `--quantities` ·
`--materials` · `--classifications` · `--attributes` · `--relationships` ·
`--type-props` · `--documents` · `--all` · `--count` · `--spatial` ·
`--limit <N>` · `--offset <N>` · `--json`

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

Flags: `--format csv|json|ifc` · `--type <T>` · `--columns <a,b,Pset.Prop>` ·
`--separator <sep>` · `--schema IFC2X3|IFC4|IFC4X3` · `--limit <N>` · `--out <file>`

(For glTF / Parquet / IFC5 export use the SDK `@ifc-lite/export` package or
`eval`.)

## lod

```bash
ifc-lite lod model.ifc --level 0 --out model.lod0.json
ifc-lite lod model.ifc --level 1 --out model.glb --meta model.lod1.json
```

Flags: `--level 0|1` · `--out <file>` (required for LOD1) · `--meta <file>` ·
`--quality low|medium|high` · `--json`. LOD0 = bbox/transform/centroid/identity
JSON; LOD1 = GLB + metadata (falls back to box geometry if meshing fails).

## ids

```bash
ifc-lite ids model.ifc requirements.ids --json --locale de
```

Flags: `--json` · `--locale en|de|fr`. Exit 0 (pass) / 1 (fail).

## bcf

```bash
ifc-lite bcf create --title "Missing fire door" --description "Level 2" --out issue.bcf
ifc-lite bcf list issues.bcf
ifc-lite bcf add-comment --file issues.bcf --text "Fixed in rev 3" --out updated.bcf
```

## create

30+ element types, with `--pset` / `--qset` / `--material` / `--color`, or
`--from-json` (reads stdin). `--out <file>` is required.

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
| Other | `space`, `plate`, `furnishing`, `proxy` |

```bash
ifc-lite create wall --start 0,0,0 --end 5,0,0 --height 3 --thickness 0.2 --out wall.ifc
ifc-lite create slab --width 10 --depth 8 --thickness 0.3 --out slab.ifc
ifc-lite create wall --out w.ifc \
  --pset '{"Name":"Pset_WallCommon","Properties":[{"Name":"IsExternal","NominalValue":true}]}'
echo '{"Start":[0,0,0],"End":[10,0,0],"Height":3,"Thickness":0.2}' | ifc-lite create wall --from-json --out wall.ifc
```

Common flags: `--start/--end/--position <x,y,z>` · `--height/--width/--depth/--thickness <N>` ·
`--name` · `--project` · `--storey` · `--elevation` · `--pset/--qset/--material <json>` ·
`--color <r,g,b>` · `--from-json` · `--out <file>` · `--json`. Coordinates are IFC **Z-up**.

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

## eval / run / schema

```bash
ifc-lite eval model.ifc "bim.query().byType('IfcDoor').toArray().filter(d => d.name.includes('Fire'))"
ifc-lite run analysis.js model.ifc          # `bim` is global in the script
ifc-lite schema            # full API JSON (namespaces: model, query, viewer, mutate, create, export, ids, bcf)
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

## Pipe patterns

```bash
ifc-lite query model.ifc --type IfcDoor --json | jq -r '.[].name'
for f in *.ifc; do echo "$f: $(ifc-lite query "$f" --type IfcWall --count) walls"; done
ifc-lite merge arch.ifc struct.ifc --out fed.ifc && ifc-lite validate fed.ifc
ifc-lite bsdd psets IfcWall | jq '.["Pset_WallCommon"]'
```
