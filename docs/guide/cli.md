# CLI Toolkit

The `@ifc-lite/cli` package provides a complete BIM toolkit for the terminal. Query, validate, export, create, merge, convert, diff, and script IFC files — no browser or viewer required.

Designed for both **humans** and **LLM terminals** (Claude Code, Cursor, Windsurf, etc.).

## Installation

```bash
npm install -g @ifc-lite/cli
```

Or run directly with npx:

```bash
npx @ifc-lite/cli info model.ifc
```

## Quick Start

```bash
# Inspect a model
ifc-lite info model.ifc

# Query walls
ifc-lite query model.ifc --type IfcWall

# Export to CSV
ifc-lite export model.ifc --format csv --type IfcWall --out walls.csv

# Validate against IDS rules
ifc-lite ids model.ifc requirements.ids

# Create an IFC file from scratch
ifc-lite create wall --height 3 --thickness 0.2 --out wall.ifc

# Merge multiple files
ifc-lite merge arch.ifc struct.ifc mep.ifc --out federated.ifc

# Convert schema version
ifc-lite convert model.ifc --schema IFC4 --out model-ifc4.ifc

# Compare two files
ifc-lite diff model-v1.ifc model-v2.ifc

# Validate structure
ifc-lite validate model.ifc

# Detect geometric clashes
ifc-lite clash model.ifc --matrix

# Model KPIs and health check
ifc-lite stats model.ifc

# Ask questions in natural language
ifc-lite ask model.ifc "how many walls?"

# Pull suspect entities into a small standalone IFC
ifc-lite extract-entities model.ifc --product 2O2Fr\$t4X7Zf8NOew3FLKr --out subset.ifc

# Evaluate SDK expressions
ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"

# Generate lightweight preview artifacts
ifc-lite lod model.ifc --level 0 --out model.lod0.json
ifc-lite lod model.ifc --level 1 --out model.glb --meta model.lod1.json
```

### Global Flags

Available on every command:

| Flag | Description |
|------|-------------|
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |
| `--json` | Machine-readable output |
| `--verbose` | Show parser and geometry diagnostics on stderr |
| `--quiet` | Errors only |
| `--debug` | Verbose plus stack traces on error |
| `--log-level <level>` | `error`, `warn`, `info`, or `debug` (explicit level wins over the shorthands) |

## Commands

### `view` — 3D Viewer

Launch an interactive WebGL 2 viewer in the browser. Control it from the terminal, scripts, or AI assistants via REST API.

```bash
ifc-lite view model.ifc                          # Open in browser
ifc-lite view model.ifc --port 3456 --no-open    # Fixed port, no auto-open
ifc-lite view --empty --port 3456                 # Empty scene for live creation
```

While running, type interactive commands (`colorize IfcWall red`, `isolate IfcSlab`, `view top`, `reset`) or send commands from another terminal:

```bash
ifc-lite view --port 3456 --send '{"action":"colorize","type":"IfcWall","color":[1,0,0,1]}'
```

The viewer exposes a REST API for external tool integration (`/api/command`, `/api/create`, `/api/export`, `/api/status`). See the full [3D Viewer & Analysis](viewer-api.md) guide for details.

**Flags:**

| Flag | Description |
|------|-------------|
| `--port <N>` | Listen on a specific port (default: random) |
| `--no-open` | Don't auto-open the browser |
| `--empty` | Start with an empty scene |
| `--send <json>` | Send a command to an already-running viewer |

---

### `analyze` — Visual Analysis

Query entities and push color overlays to a running viewer. Requires a viewer to be running first.

```bash
# Start viewer, then analyze
ifc-lite view model.ifc --port 3456 --no-open &

ifc-lite analyze model.ifc --viewer 3456 --type IfcWall --color red
ifc-lite analyze model.ifc --viewer 3456 --type IfcWall --missing "Pset_WallCommon.FireRating" --color red
ifc-lite analyze model.ifc --viewer 3456 --type IfcSlab --heatmap "Qto_SlabBaseQuantities.GrossArea"
ifc-lite analyze model.ifc --viewer 3456 --type IfcDoor --isolate --color green --flyto
ifc-lite analyze model.ifc --viewer 3456 --rules rules.json --json
```

Supports property filters (`--where`), missing-property checks (`--missing`), heatmaps (`--heatmap`), and batch rules from a JSON file (`--rules`). See the full [3D Viewer & Analysis](viewer-api.md#analyze-visual-analysis-overlay) guide.

**Flags:**

| Flag | Description |
|------|-------------|
| `--viewer <port>` | Port of running viewer (**required**) |
| `--type <T>` | IFC type to analyze |
| `--missing <Pset.Prop>` | Find entities missing a property |
| `--where <expr>` | Property filter (e.g. `GrossArea>100`) |
| `--color <name>` | Color matched entities |
| `--heatmap <Pset.Prop>` | Gradient color by numeric value |
| `--palette <name>` | Heatmap palette: `blue-red`, `green-red`, `rainbow` |
| `--isolate` | Hide non-matching entities |
| `--flyto` | Fly camera to results |
| `--rules <file>` | Batch rules from JSON |
| `--json` | Machine-readable output |

---

### `info` — Model Summary

Print schema version, entity counts, storeys, and top entity types.

```bash
ifc-lite info model.ifc
ifc-lite info model.ifc --json
```

=== "Table Output"

    ```
      File:     model.ifc
      Schema:   IFC4
      Size:     12.3 MB
      Entities: 45,821
      Parsed:   340ms

      Storeys:
        - Ground Floor
        - First Floor
        - Second Floor

      Entity types (top 10):
         Type              │ Count
        ───────────────────┼───────
         IfcWall           │ 234
         IfcDoor           │ 87
         IfcWindow         │ 156
         ...
    ```

=== "JSON Output (--json)"

    ```json
    {
      "file": "model.ifc",
      "schema": "IFC4",
      "fileSize": 12902400,
      "entityCount": 45821,
      "parseTime": "340ms",
      "storeys": ["Ground Floor", "First Floor", "Second Floor"],
      "typeCounts": {
        "IfcWall": 234,
        "IfcDoor": 87,
        "IfcWindow": 156
      }
    }
    ```

---

### `stats` - Model KPIs

Auto-calculated building metrics and a model health check in one command.

```bash
ifc-lite stats model.ifc
ifc-lite stats model.ifc --json
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--json` | Full report as JSON |

---

### `query` — Query Entities

Filter entities by type, properties, or spatial structure. Optionally include properties, quantities, materials, classifications, attributes, relationships, type properties, and documents.

```bash
# By type
ifc-lite query model.ifc --type IfcWall
ifc-lite query model.ifc --type IfcWall,IfcDoor

# With property filter
ifc-lite query model.ifc --type IfcWall --where "Pset_WallCommon.IsExternal=true"

# With properties and quantities included
ifc-lite query model.ifc --type IfcWall --props --quantities --json

# With materials, classifications, and relationships
ifc-lite query model.ifc --type IfcWall --materials --classifications --relationships --json

# All data at once
ifc-lite query model.ifc --type IfcWall --all --json

# Count only
ifc-lite query model.ifc --type IfcDoor --count

# Aggregate quantities
ifc-lite query model.ifc --type IfcWall --sum GrossSideArea
ifc-lite query model.ifc --type IfcWall --group-by material --json

# Discover which quantity/property names exist on a type
ifc-lite query model.ifc --type IfcWall --quantity-names
ifc-lite query model.ifc --type IfcWall --property-names

# Spatial tree
ifc-lite query model.ifc --spatial
ifc-lite query model.ifc --spatial --summary

# Pagination
ifc-lite query model.ifc --type IfcWall --limit 10 --offset 20
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--type <T>` | Filter by IFC type (comma-separated) |
| `--where <filter>` | Property filter: `PsetName.PropName=Value` |
| `--storey <name>` | Filter to elements in a storey |
| `--props` | Include property sets in output |
| `--quantities` | Include quantity sets in output |
| `--materials` | Include material assignments |
| `--classifications` | Include classification references |
| `--attributes` | Include IFC schema attributes |
| `--relationships` | Include relationship data |
| `--type-props` | Include type-level properties |
| `--documents` | Include linked documents |
| `--all` | Include all data (properties, quantities, materials, etc.) |
| `--count` | Return count instead of entities |
| `--sum` / `--avg` / `--min` / `--max <Qty>` | Aggregate a quantity across matches |
| `--group-by <key>` | Group results (e.g. `material`) |
| `--unique <prop>` | List distinct values of a property |
| `--quantity-names` | List quantity names present on a type (requires `--type`) |
| `--property-names` | List property names present on a type (requires `--type`) |
| `--sort <key>` / `--desc` | Sort results |
| `--spatial` | Show spatial tree (storeys and elements) |
| `--summary` | Condensed spatial tree (with `--spatial`) |
| `--limit <N>` | Limit result count |
| `--offset <N>` | Skip first N results |
| `--json` | JSON output |

---

### `props` — Entity Properties

Show all properties, quantities, materials, classifications, and relationships for a single entity.

```bash
ifc-lite props model.ifc --id 42
```

Returns a complete JSON object with:

- `attributes` — IFC schema attributes (Name, Description, ObjectType, etc.)
- `properties` — All IfcPropertySet data
- `quantities` — All IfcElementQuantity data
- `classifications` — Classification references
- `materials` — Material assignments (layers, profiles, constituents)
- `typeProperties` — Properties from the entity's type object
- `relationships` — Voids, fills, groups, connections

---

### `export` — Export Data

Export entity data to CSV, JSON, IFC STEP, and other formats.

```bash
# CSV export
ifc-lite export model.ifc --format csv --type IfcWall --columns Name,Type,GlobalId

# JSON export
ifc-lite export model.ifc --format json --type IfcWall,IfcDoor

# With property columns (dot notation)
ifc-lite export model.ifc --format csv --type IfcWall \
  --columns Name,Type,Pset_WallCommon.IsExternal,Pset_WallCommon.FireRating

# IFC STEP re-export with schema conversion
ifc-lite export model.ifc --format ifc --schema IFC4 --out filtered.ifc

# Limit results
ifc-lite export model.ifc --format csv --type IfcWall --limit 50

# Write to file
ifc-lite export model.ifc --format csv --out walls.csv
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `csv`, `json`, `ifc`, `obj`, `gltf`, `glb`, `jsonld`, `step`, `ifcx`, or `hbjson` |
| `--type <T>` | Filter entities by type |
| `--where <filter>` | Property filter: `PsetName.PropName=Value` |
| `--storey <name>` | Filter to elements in a storey |
| `--columns <cols>` | Comma-separated columns (supports `PsetName.PropName`) |
| `--separator <sep>` | CSV separator (default: `,`) |
| `--schema <ver>` | IFC schema for STEP export (`IFC2X3`, `IFC4`, `IFC4X3`) |
| `--name <str>` | Model name for geometry exports |
| `--limit <N>` | Limit result count |
| `--diagnostics` | Print a geometry summary after mesh-based exports |
| `--out <file>` | Write to file instead of stdout |

---

### `diagnose-geometry` - Geometry Diagnostics

Run geometry extraction headlessly and report CSG / opening diagnostics: opening classification, per-reason failure breakdown, fast-path engagement, and the worst-failing host elements. This is the same diagnostics contract the viewer and server surface.

```bash
ifc-lite diagnose-geometry model.ifc
ifc-lite diagnose-geometry model.ifc --json
ifc-lite diagnose-geometry model.ifc --type IfcWall
ifc-lite diagnose-geometry model.ifc --product '0YvCT2_$X3_xJG3rzD8L_8'
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--product <id\|GUID>` | Narrow the worst-hosts detail to one product (express ID or GlobalId) |
| `--type <T>` | Narrow the worst-hosts detail to one IFC type |
| `--out <file>` | Write the report to a file |
| `--json` | Raw diagnostics object as JSON |

Aggregate counts always describe the whole file; `--product` / `--type` only narrow which per-product rows are shown.

---

### `extract-entities` - Isolate Entities

Pull selected entities out of a large IFC into a small, valid, viewable standalone model. Useful for reproducing a suspect element in isolation.

```bash
# By GlobalId or express ID (repeatable, or comma-separated)
ifc-lite extract-entities model.ifc --product '2O2Fr$t4X7Zf8NOew3FLKr' --out subset.ifc

# By type or storey
ifc-lite extract-entities model.ifc --type IfcWall --out walls.ifc
ifc-lite extract-entities model.ifc --storey "Level 2" --out level2.ifc

# Auto-triage: extract the N most unusual meshes
ifc-lite extract-entities model.ifc --detect --top 10 --out suspects.ifc

# Triage report only, no extraction
ifc-lite extract-entities model.ifc --detect --report --json

# Extract and open the result in the 3D viewer
ifc-lite extract-entities model.ifc --type IfcStair --out stairs.ifc --view
```

Selectors are unioned. The output carries each selected product's full forward reference closure plus the shared context roots (IfcProject, units, geometric contexts, the site/building/storey skeleton), spatial-containment relations, and each kept host's openings and fillers (IfcRelVoidsElement / IfcRelFillsElement), so the subset parses and renders on its own.

**Flags:**

| Flag | Description |
|------|-------------|
| `--product <id\|GUID>` | Select specific products (repeatable or comma-separated) |
| `--type <T>` | Select every product of a type |
| `--storey <GUID\|name\|id>` | Select every product placed under a storey |
| `--detect` | Select the meshes a geometry-triage pass ranks most unusual |
| `--top <N>` | How many triage hits to keep (default 20, with `--detect`) |
| `--report` | Print the triage report without extracting (with `--detect`) |
| `--out <file>` | Output IFC file |
| `--view` | Open the extracted subset in the 3D viewer |
| `--port <N>` | Viewer port (with `--view`) |
| `--json` | Machine-readable output |

---

### `lod` — Lightweight LOD Artifacts

Generate lightweight geometry artifacts for previews, offline packaging, and
degraded delivery flows.

```bash
# LOD0 JSON envelopes
ifc-lite lod model.ifc --level 0 --out model.lod0.json

# LOD1 GLB + metadata
ifc-lite lod model.ifc --level 1 --out model.glb --meta model.lod1.json

# Machine-readable summary
ifc-lite lod model.ifc --level 1 --out model.glb --json
```

`LOD0` produces JSON with:
- world-space bounding boxes
- transforms
- centroids
- IFC class and identity metadata

`LOD1` produces:
- a GLB geometry file
- a metadata JSON file with generation status and expressId mapping

If meshing fails, LOD1 falls back to box geometry derived from LOD0.

**Flags:**

| Flag | Description |
|------|-------------|
| `--level <N>` | `0` for JSON envelopes, `1` for GLB geometry |
| `--out <file>` | Output file (`required` for LOD1) |
| `--meta <file>` | Metadata file for LOD1 (default: derived from `--out`) |
| `--quality <q>` | Geometry quality for LOD1: `low`, `medium`, `high` (also accepts `fast`, `balanced`) |
| `--json` | Machine-readable summary to stdout |

---

### `ids` — IDS Validation

Validate an IFC file against IDS (Information Delivery Specification) rules.

```bash
ifc-lite ids model.ifc requirements.ids
ifc-lite ids model.ifc requirements.ids --json
ifc-lite ids model.ifc requirements.ids --locale de
```

Returns pass/fail summary with exit code 0 (pass) or 1 (fail).

**Flags:**

| Flag | Description |
|------|-------------|
| `--json` | Full validation report as JSON |
| `--locale <lang>` | Message language: `en`, `de`, `fr` |

---

### `bcf` — BCF Collaboration

Create, read, and manage BCF (BIM Collaboration Format) files.

```bash
# Create a new BCF issue
ifc-lite bcf create --title "Missing fire door" --description "Level 2, Room 201" --out issue.bcf

# List topics in a BCF file
ifc-lite bcf list issues.bcf

# Add a comment to a BCF file
ifc-lite bcf add-comment --file issues.bcf --text "Fixed in revision 3" --out updated.bcf
```

---

### `clash` - Clash Detection

Detect geometric clashes between elements. Meshes the model headlessly, then runs the clash engine with either a single ad-hoc rule (`--a` / `--b`) or the standard discipline matrix (`--matrix`). Results can be exported as a BCF archive.

```bash
# Standard discipline matrix
ifc-lite clash model.ifc --matrix
ifc-lite clash model.ifc --matrix --json

# Ad-hoc rule: ducts/pipes vs walls, 5 cm clearance
ifc-lite clash model.ifc --a "IfcDuct*|IfcPipe*" --b "IfcWall*" --mode clearance --clearance 0.05

# Export clashes as BCF topics
ifc-lite clash model.ifc --matrix --bcf clashes.bcfzip
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--matrix` | Run the standard discipline matrix rules |
| `--a <pattern>` | Type pattern for set A (glob, `\|`-separated; default `*`) |
| `--b <pattern>` | Type pattern for set B |
| `--mode <m>` | `hard` (default) or `clearance` |
| `--tolerance <m>` | Penetration tolerance in metres (hard mode) |
| `--clearance <m>` | Required clearance in metres (clearance mode) |
| `--bcf <file>` | Write results as a BCF archive |
| `--group <g>` | BCF topic grouping: `cluster` (default), `rule`, `typePair`, `element` |
| `--bcf-status <s>` | Topic status for exported BCF topics |
| `--max-topics <N>` | Cap the number of BCF topics |
| `--json` | JSON output |

---

### `create` — Create IFC Files

Generate IFC building elements from CLI flags or JSON input. Supports **29 element types** with property sets, quantities, materials, and colors.

```bash
# Basic elements
ifc-lite create wall --start 0,0,0 --end 5,0,0 --height 3 --thickness 0.2 --out wall.ifc
ifc-lite create slab --width 10 --depth 8 --thickness 0.3 --out slab.ifc
ifc-lite create column --position 0,0,0 --height 3 --width 0.3 --depth 0.3 --out column.ifc
ifc-lite create beam --start 0,0,3 --end 5,0,3 --width 0.2 --height 0.4 --out beam.ifc

# Stairs, roofs, doors, windows
ifc-lite create stair --number-of-risers 12 --riser-height 0.175 --tread-length 0.28 --width 1.2 --out stair.ifc
ifc-lite create roof --width 10 --depth 8 --thickness 0.25 --position 0,0,3 --out roof.ifc
ifc-lite create gable-roof --width 10 --depth 8 --slope 0.5 --thickness 0.25 --out gable.ifc
ifc-lite create door --width 0.9 --height 2.1 --position 0,0,0 --out door.ifc
ifc-lite create window --width 1.2 --height 1.5 --position 0,0,1 --out window.ifc

# Structural elements
ifc-lite create footing --width 2 --depth 2 --height 0.5 --predefined-type PAD_FOOTING --out footing.ifc
ifc-lite create pile --length 10 --diameter 0.6 --position 0,0,0 --out pile.ifc
ifc-lite create ramp --width 1.5 --length 5 --thickness 0.2 --rise 0.5 --out ramp.ifc
ifc-lite create railing --start 0,0,0 --end 5,0,0 --height 1.0 --out railing.ifc
ifc-lite create member --start 0,0,0 --end 3,0,3 --width 0.1 --height 0.1 --out brace.ifc

# Special elements
ifc-lite create space --width 5 --depth 4 --height 3 --long-name "Living Room" --out room.ifc
ifc-lite create curtain-wall --start 0,0,0 --end 10,0,0 --height 3 --out curtain.ifc
ifc-lite create furnishing --width 1 --depth 0.6 --height 0.8 --name "Desk" --out desk.ifc
ifc-lite create proxy --width 1 --depth 1 --height 1 --name "Unknown Element" --out proxy.ifc
ifc-lite create plate --width 2 --depth 1 --thickness 0.01 --out plate.ifc

# Advanced profiles
ifc-lite create circular-column --radius 0.15 --height 3 --out col.ifc
ifc-lite create hollow-circular-column --radius 0.3 --wall-thickness 0.02 --height 3 --out hcol.ifc
ifc-lite create i-shape-beam --overall-width 0.2 --overall-depth 0.4 --web-thickness 0.01 --flange-thickness 0.015 --out ib.ifc
ifc-lite create l-shape-member --depth 0.1 --width 0.1 --thickness 0.01 --out lm.ifc
ifc-lite create t-shape-member --flange-width 0.15 --depth 0.15 --web-thickness 0.008 --out tm.ifc
ifc-lite create u-shape-member --depth 0.15 --flange-width 0.08 --web-thickness 0.008 --out um.ifc
ifc-lite create rectangle-hollow-beam --xdim 0.1 --ydim 0.2 --wall-thickness 0.005 --out rhb.ifc

# With property sets, materials, and colors
ifc-lite create wall --out w.ifc \
  --pset '{"Name":"Pset_WallCommon","Properties":[{"Name":"IsExternal","NominalValue":true}]}'
ifc-lite create wall --out w.ifc \
  --material '{"Name":"Concrete","Category":"Structural"}'
ifc-lite create wall --out w.ifc --color 0.8,0.2,0.2

# From JSON (pipe-friendly)
echo '{"Start":[0,0,0],"End":[10,0,0],"Height":3,"Thickness":0.2}' \
  | ifc-lite create wall --from-json --out wall.ifc
```

**Supported element types:**

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

**Common Flags:**

| Flag | Description |
|------|-------------|
| `--start <x,y,z>` | Start point (walls, beams, railings) |
| `--end <x,y,z>` | End point (walls, beams, railings) |
| `--position <x,y,z>` | Position (columns, doors, slabs, etc.) |
| `--height <N>` | Element height |
| `--width <N>` | Element width |
| `--depth <N>` | Element depth |
| `--thickness <N>` | Element thickness |
| `--name <str>` | Element name |
| `--project <str>` | Project name |
| `--storey <str>` | Storey name |
| `--elevation <N>` | Storey elevation |
| `--pset <json>` | Add property set (JSON) |
| `--qset <json>` | Add element quantity (JSON) |
| `--material <json>` | Add material (JSON) |
| `--color <r,g,b>` | Set color (0-1 per channel) |
| `--from-json` | Read parameters from stdin JSON |
| `--out <file>` | Output IFC file (required) |
| `--json` | Output creation stats as JSON |

---

### `mutate` - Modify Properties

Modify properties or attributes of IFC entities and save the result as a new file.

```bash
# Set a property on one entity
ifc-lite mutate model.ifc --id 42 --set Pset_WallCommon.IsExternal=true --out out.ifc

# Set an attribute (no dot = attribute)
ifc-lite mutate model.ifc --id 42 --set Name=TestWall --out out.ifc

# Bulk: all walls matching a filter
ifc-lite mutate model.ifc --type IfcWall --where "Pset_WallCommon.IsExternal=true" \
  --set Pset_WallCommon.FireRating=REI60 --out out.ifc
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--id <N>` | Target a single entity by express ID |
| `--type <T>` | Target all entities of a type |
| `--where <filter>` | Narrow `--type` targets: `Pset.Prop<op>Value` (`=`, `!=`, `>`, `<`, `>=`, `<=`, `contains`) |
| `--set <P=V>` | Property (`Pset.Prop=Value`) or attribute (`Name=Value`) to set; repeatable (required) |
| `--out <file>` | Output file (required) |
| `--json` | Mutation stats as JSON |

---

### `generate-spaces` - Derive IfcSpace

Derive IfcSpace volumes from the building's walls (room footprints), using storey datums for floor-to-floor height, and write the augmented IFC.

```bash
ifc-lite generate-spaces model.ifc --out with-spaces.ifc
ifc-lite generate-spaces model.ifc --storey "Level 1" --out l1.ifc
ifc-lite generate-spaces model.ifc --dry-run --json
ifc-lite generate-spaces model.ifc --list-storeys
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--out <file>` | Output IFC with the new IfcSpace entities (omit with `--dry-run`) |
| `--storey <id\|name\|all>` | Storey express ID, name substring, or `all` (default) |
| `--snap <m\|auto>` | Corner-closing tolerance in metres, or `auto` (default) |
| `--height <m\|auto>` | Space height in metres, or `auto` = floor-to-floor (default) |
| `--top-height <m>` | Height for the topmost storey under `auto` (default 3) |
| `--min-area <m2>` | Drop regions below this area (default 0.5) |
| `--name-pattern <p>` | Name template; `{n}` = index, `{storey}` = storey name |
| `--predefined-type <t>` | IfcSpacePredefinedType (default `INTERNAL`) |
| `--boundary <mode>` | Space boundary vs walls: `center`, `inner` (default), `outer` |
| `--divider-type <t>` | Extra element type to treat as a wall divider (repeatable) |
| `--dry-run` | Detect and report only; write nothing |
| `--force` | Re-derive even if the model already has generated spaces (may duplicate) |
| `--list-storeys` | List storeys (ID, name, elevation) and exit |
| `--json` | Machine-readable output |

---

### `merge` — Merge IFC Files

Combine multiple IFC files into a single federated model.

```bash
# Merge two files
ifc-lite merge arch.ifc struct.ifc --out federated.ifc

# Merge multiple files with schema conversion
ifc-lite merge file1.ifc file2.ifc file3.ifc --schema IFC4 --out merged.ifc

# JSON output with stats
ifc-lite merge a.ifc b.ifc --out merged.ifc --json

# Mixed units: rescale every model into the first file's unit (one single-unit project)
ifc-lite merge metric.ifc imperial.ifc --unit-reconciliation normalize --out merged.ifc
```

The merger unifies spatial hierarchy (sites, buildings, storeys) by name and elevation, and offsets entity IDs to avoid collisions. Models that share the first file's length unit merge into a single IfcProject; a model with a different unit is federated (kept as its own project) unless `--unit-reconciliation normalize` rescales it into the first file's unit. The per-container matching strategy can be pinned down with `--merge-sites` / `--merge-buildings` / `--merge-storeys` (see [Spatial matching strategy](exporting.md#spatial-matching-strategy)).

**Flags:**

| Flag | Description |
|------|-------------|
| `--schema <ver>` | Target schema (`IFC2X3`, `IFC4`, `IFC4X3`) |
| `--unit-reconciliation <mode>` | Mixed-unit handling: `auto` (default, federate differing units), `normalize` (rescale into the first file's unit → one single-unit project), `assume-shared` (force one project without rescaling) |
| `--merge-sites <mode>` | IfcSite matching across models: `single` (unify iff each model has exactly one site, Name ignored) or `by-name` (Name match only, no single-instance fallback). Omitted: Name match, else single-instance fallback |
| `--merge-buildings <mode>` | Same modes as `--merge-sites`, applied to IfcBuilding |
| `--merge-storeys <mode>` | IfcBuildingStorey matching: `by-name`, `by-elevation`, or `by-name-then-elevation` (default) |
| `--out <file>` | Output file (required) |
| `--json` | Output merge stats as JSON |

---

### `convert` — Schema Conversion

Convert an IFC file between schema versions.

```bash
ifc-lite convert model.ifc --schema IFC4 --out model-ifc4.ifc
ifc-lite convert old-model.ifc --schema IFC4X3 --out modern.ifc
ifc-lite convert model.ifc --schema IFC2X3 --out legacy.ifc --json
```

Handles entity type mapping automatically (e.g., `IfcWallStandardCase` → `IfcWall` when upgrading from IFC2X3 to IFC4).

**Flags:**

| Flag | Description |
|------|-------------|
| `--schema <ver>` | Target schema: `IFC2X3`, `IFC4`, `IFC4X3`, `IFC5` (required) |
| `--out <file>` | Output file (required) |
| `--json` | Output conversion stats as JSON |

---

### `diff` — Compare IFC Files

Compare two IFC files and report differences.

```bash
# Type-level comparison
ifc-lite diff model-v1.ifc model-v2.ifc

# With entity-level comparison by GlobalId
ifc-lite diff model-v1.ifc model-v2.ifc --by-entity

# JSON output
ifc-lite diff model-v1.ifc model-v2.ifc --json
```

Reports:

- Entity count differences
- Type-level additions/removals
- GlobalId-based entity tracking (with `--by-entity`)

**Flags:**

| Flag | Description |
|------|-------------|
| `--by-entity` | Compare entities by GlobalId |
| `--json` | JSON output |

---

### `validate` — Structural Validation

Check an IFC file for structural issues.

```bash
ifc-lite validate model.ifc
ifc-lite validate model.ifc --json
```

Checks:

- Required entities (IfcProject, IfcSite, IfcBuilding)
- Single IfcProject presence
- Building storeys existence
- GlobalId uniqueness
- Named elements

Returns exit code 0 (valid) or 1 (errors found).

**Flags:**

| Flag | Description |
|------|-------------|
| `--json` | Full report as JSON |

---

### `bsdd` — buildingSMART Data Dictionary

Query the bSDD API for IFC class information, property sets, and search.

```bash
# Get class info
ifc-lite bsdd class IfcWall

# Search for classes
ifc-lite bsdd search "concrete wall"

# List standard property sets
ifc-lite bsdd psets IfcWall

# List standard quantity sets
ifc-lite bsdd qsets IfcSlab
```

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `class <IfcType>` | Get class info (definition, related types, properties) |
| `search <query>` | Search bSDD for classes by keyword |
| `psets <IfcType>` | List standard property sets and their properties |
| `qsets <IfcType>` | List standard quantity sets |

---

### `ext` — Extension Toolkit

Author, validate, sign, and run tests against IFClite extensions. The `ext` subcommands are the hand-authoring side of the [Extensions](extensions.md) feature.

```bash
# Scaffold a starter bundle
ifc-lite ext init my-tool
ifc-lite ext init my-tool --id com.example.my-tool --name "My Tool"

# Validate a bundle directory or manifest.json
ifc-lite ext validate ./my-tool
ifc-lite ext validate ./my-tool --json

# Pack a directory into a .iflx
ifc-lite ext pack ./my-tool --out my-tool.iflx

# Run manifest.tests against a bundle
ifc-lite ext test ./my-tool
ifc-lite ext test ./my-tool --bail --json

# Generate an Ed25519 keypair for signing
ifc-lite ext keygen --out ~/.config/ifclite/key --label "Alice"

# Sign a bundle (or pack + sign in one step)
ifc-lite ext sign ./my-tool --key ~/.config/ifclite/key.private.iflk --out my-tool.iflx
ifc-lite ext pack ./my-tool --sign --key ~/.config/ifclite/key.private.iflk --out my-tool.iflx

# Verify a .iflx (with optional public-key fingerprint check)
ifc-lite ext verify my-tool.iflx
ifc-lite ext verify my-tool.iflx --key ~/.config/ifclite/key.public.iflk --json
```

**Subcommands:**

| Subcommand | Purpose |
|------------|---------|
| `init <dir>` | Scaffold a minimal valid bundle (manifest, README, one command). |
| `validate <path>` | Validate a manifest or a bundle directory. |
| `pack <dir>` | Pack a directory into a `.iflx`, optionally signed. |
| `test <dir>` | Run `manifest.tests` against an in-process sandbox. Exits non-zero on any failure. |
| `keygen` | Generate an Ed25519 keypair and write `<prefix>.public.iflk` + `<prefix>.private.iflk` (private file is `0600`). |
| `sign <bundle>` | Sign a directory or unsigned `.iflx`. |
| `verify <bundle>` | Inspect a `.iflx` — manifest, files, capabilities, signature. With `--key`, verify the embedded signature matches the expected public key fingerprint. |
| `capabilities` | List every capability in the catalogue. |

**Common flags:**

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable output (validate / test / verify) |
| `--bail` | Stop on first test failure (`ext test`) |
| `--out <file>` | Output path (pack / sign / keygen) |
| `--key <file>` | Key file path (sign / verify) |
| `--id <id>` | Override the manifest id during `ext init` |
| `--name <name>` | Override the manifest name during `ext init` |

The full design lives in [Authoring Extensions](extension-authoring.md). For the security model — capability grammar, sandbox limits, signing semantics — see [the threat-model RFC](../architecture/ai-customization/02-security.md).

---

### `eval` — Evaluate Expressions

Evaluate JavaScript expressions against the BIM SDK. The `bim` object provides the full `@ifc-lite/sdk` API.

```bash
# Count walls
ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"

# List storey names
ifc-lite eval model.ifc "bim.storeys().map(s => s.name)"

# Get properties of a specific entity
ifc-lite eval model.ifc "bim.properties({modelId:'default', expressId:42})"

# Complex query
ifc-lite eval model.ifc "bim.query().byType('IfcDoor').toArray().filter(d => d.name.includes('Fire'))"
```

!!! tip "Power Move for LLMs"
    The `eval` command is the most flexible tool. LLMs can write arbitrary SDK code and execute it without needing dedicated subcommands. The full API is discoverable via `ifc-lite schema`.

---

### `ask` - Natural Language Queries

Answer common BIM questions in plain language. A recipe engine maps question patterns to SDK operations; no external AI service is involved.

```bash
ifc-lite ask model.ifc "how many walls?"
ifc-lite ask model.ifc "what is the window-wall ratio?" --json
ifc-lite ask model.ifc "list materials" --explain
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable output |
| `--explain` | Show which recipe matched and how the answer was computed |

---

### `run` — Execute Scripts

Run JavaScript files with the full `bim` SDK available.

```bash
ifc-lite run analysis.js model.ifc
```

**Example script (`analysis.js`):**

```javascript
const walls = bim.query().byType('IfcWall').toArray();
console.log(`Found ${walls.length} walls`);

for (const wall of walls) {
  const props = bim.properties(wall.ref);
  const psetCommon = props.find(p => p.name === 'Pset_WallCommon');
  const isExternal = psetCommon?.properties.find(p => p.name === 'IsExternal');
  console.log(`  ${wall.name}: external=${isExternal?.value ?? 'unknown'}`);
}

const storeys = bim.storeys();
console.log(`\n${storeys.length} storeys:`);
for (const s of storeys) {
  const elements = bim.contains(s.ref);
  console.log(`  ${s.name}: ${elements.length} elements`);
}
```

---

### `schema` — API Schema

Dump the complete SDK API schema as JSON. Useful for LLM tools to discover available methods.

```bash
ifc-lite schema              # Full schema with params and return types
ifc-lite schema --compact    # Minimal: names and descriptions only
```

The schema includes the runtime SDK namespaces: `model`, `query`, `viewer`, `mutate`, `store`, `lens`, `create`, `files`, `schedule`, `clash`, `export`, and their methods with parameter names, return types, and LLM semantic hints.

---

### `mcp` - MCP Server

Start a Model Context Protocol server bound to one or more IFC files, so MCP-capable agents (Claude Code, Cursor, etc.) can query and edit the models through tools.

```bash
ifc-lite mcp model.ifc
ifc-lite mcp model.ifc --read-only
ifc-lite mcp arch.ifc struct.ifc
ifc-lite mcp model.ifc --transport http --port 8765 --token abc
ifc-lite mcp model.ifc --viewer          # also start the 3D viewer
```

!!! note "HTTP transport starts with an empty session"
    In `--transport http` mode the positional files are **not** preloaded: every
    HTTP session gets its own empty model registry. Load a model into the session
    with the `model_load` tool (which needs `mutate` scope, so it is hidden under
    `--read-only`). The default `stdio` transport does preload the files you pass.

**Flags:**

| Flag | Description |
|------|-------------|
| `--transport <t>` | `stdio` (default) or `http` |
| `--port <N>` | HTTP port (default 8765) |
| `--host <h>` | HTTP host (default 127.0.0.1; non-loopback requires `--token` or `--insecure`) |
| `--token <bearer>` | HTTP bearer token for full scope |
| `--insecure` | Allow non-loopback bind without a token (development only) |
| `--read-only` | Hide mutation tools |
| `--bsdd <url>` | Override the bSDD endpoint |
| `--allow <path>` | Restrict file-system access (repeatable) |
| `--viewer` | Auto-open the 3D viewer |
| `--viewer-port <N>` | Preferred viewer port (0 = auto) |
| `--open` | Auto-open the viewer and open the URL in the browser |

## Output Modes

Every command supports structured output:

| Mode | Flag | Use Case |
|------|------|----------|
| Table | *(default)* | Human-readable terminal output |
| JSON | `--json` | Machine-readable, pipe to `jq` |
| CSV | `--format csv` | Spreadsheet-compatible |

**Design principles:**

- **stdout** = data (JSON, CSV, tables)
- **stderr** = status messages, progress
- **Exit 0** = success, **Exit 1** = failure

## Pipe Examples

```bash
# Count walls across multiple files
for f in *.ifc; do
  count=$(ifc-lite query "$f" --type IfcWall --count)
  echo "$f: $count walls"
done

# Extract all door names as plain text
ifc-lite query model.ifc --type IfcDoor --json | jq -r '.[].name'

# Export walls to CSV, filter with standard tools
ifc-lite export model.ifc --format csv --type IfcWall | grep "External"

# Chain: create an element, then inspect it
ifc-lite create wall --out /tmp/w.ifc --height 3 --thickness 0.2
ifc-lite info /tmp/w.ifc --json

# Merge and validate
ifc-lite merge arch.ifc struct.ifc --out fed.ifc && ifc-lite validate fed.ifc

# Convert and diff
ifc-lite convert model.ifc --schema IFC4 --out v4.ifc
ifc-lite diff model.ifc v4.ifc --json

# Look up bSDD data for wall types
ifc-lite bsdd psets IfcWall | jq '.["Pset_WallCommon"]'
```

## Using with LLM Terminals

The CLI is designed to work seamlessly with AI coding assistants like Claude Code.

### Discovery

An LLM can discover all capabilities by running:

```bash
ifc-lite --help          # Overview of all commands
ifc-lite schema          # Full API schema as JSON
```

### Recommended CLAUDE.md Entry

Add this to your project's `CLAUDE.md` to help Claude Code use ifc-lite:

```markdown
## IFC Analysis

Use `ifc-lite` CLI for BIM/IFC file operations:
- `ifc-lite info <file>` - model summary
- `ifc-lite stats <file>` - model KPIs and health check
- `ifc-lite query <file> --type <T> --json` - query entities
- `ifc-lite query <file> --type <T> --all --json` - full entity data
- `ifc-lite props <file> --id <N>` - single entity details
- `ifc-lite export <file> --format csv --type <T>` - export data
- `ifc-lite lod <file> --level 0|1 --out <file>` - generate LOD0/LOD1 artifacts
- `ifc-lite create <type> --out <file>` - create IFC elements (29 types)
- `ifc-lite mutate <file> --id <N> --set P=V --out <file>` - edit properties
- `ifc-lite merge <files...> --out <file>` - merge IFC files
- `ifc-lite convert <file> --schema <VER> --out <file>` - convert schema
- `ifc-lite diff <file1> <file2>` - compare IFC files
- `ifc-lite validate <file>` - structural validation
- `ifc-lite clash <file> --matrix --json` - clash detection
- `ifc-lite extract-entities <file> --product <GUID> --out <file>` - isolate entities into a small IFC
- `ifc-lite bsdd class <IfcType>` - bSDD class info
- `ifc-lite view <file> --port <N>` - launch 3D viewer with REST API
- `ifc-lite analyze <file> --viewer <port> --type <T>` - visual analysis overlay
- `ifc-lite eval <file> "<expr>"` - evaluate SDK expressions
- `ifc-lite ask <file> "<question>"` - natural language queries
- `ifc-lite schema` - discover all SDK methods
- `ifc-lite mcp <file>` - start an MCP server on the model

Always use `--json` for machine-readable output.
Run `ifc-lite schema` to see the full API before writing eval expressions.
```

### Best Practices for LLM Usage

1. **Always use `--json`** — structured output is easier to parse
2. **Use `eval` for complex queries** — more flexible than building flags
3. **Run `schema` first** — discover the API before writing code
4. **Pipe to `jq`** — for filtering and transforming JSON output
5. **Use `--count` for quick checks** — avoid loading full entity data when just counting
6. **Use `--all` with `query`** — get complete entity data in one call
7. **Use `create --from-json`** — for programmatic element creation from generated JSON

## Command Reference

<!-- BEGIN GENERATED: cli-commands -->
| Command | Description |
|---------|-------------|
| `info` | Model summary (schema, entities, storeys) |
| `query` | Query entities by type/properties/quantities |
| `props` | All properties for a single entity |
| `export` | Export data / Honeybee energy model |
| `diagnose-geometry` | CSG / opening diagnostics (failures, classification) |
| `extract-entities` | Isolate entities into a small, viewable standalone IFC |
| `ids` | Validate against IDS rules |
| `bcf` | Work with BCF collaboration files |
| `clash` | Detect geometric clashes between elements |
| `create` | Create IFC elements (30+ types) |
| `eval` | Evaluate SDK expression |
| `run` | Execute a script against model |
| `schema` | Dump SDK API schema (for LLM tools) |
| `merge` | Merge multiple IFC files |
| `convert` | Convert between IFC schema versions |
| `diff` | Compare two IFC files |
| `validate` | Structural validation checks |
| `bsdd` | buildingSMART Data Dictionary lookup |
| `stats` | Auto-calculated model KPIs and health check |
| `mutate` | Modify properties/attributes and save |
| `generate-spaces` | Derive IfcSpace from walls (slab/roof-aware height) |
| `ask` | Natural language BIM queries |
| `view` | Interactive 3D viewer in browser |
| `analyze` | Query + visualize analysis results |
| `lod` | Generate lightweight LOD artifacts |
| `simplify` | Demesher: simplify meshes, write lighter IFC |
| `mcp` | Start an MCP server bound to one or more IFC files |
| `ext` | Manage IFClite extensions (Phase 0 — validate, init) |
| `layer` | Layered change tracking over a local store (.ifc-lite/) |
| `ref` | Manage named refs in the layer store |
<!-- END GENERATED: cli-commands -->
