# ifclite-geom

Native [ifc-lite](https://github.com/LTplus-AG/ifc-lite) geometry tessellation for
Python. It turns an IFC file into per-entity triangle meshes with no Node, no
WASM, and no subprocess: the Rust geometry kernel runs directly inside the
Python process.

Meshes come back **welded**, **IFC Z-up**, in **absolute world metres**, keyed by
IFC STEP id (occurrences only). This is the analysis-ready export, distinct from
the render-oriented GLB the viewer uses.

## Install

```bash
pip install ifclite-geom
```

Prebuilt wheels ship for CPython 3.9+ on Linux (x86_64, aarch64), macOS (Apple
silicon and Intel), and Windows (x64). No Rust toolchain needed.

## Quick start

The module is `ifclite_geom` and exposes three functions, all taking the raw IFC
file as `bytes`. `geometry_data_buffers` and `geometry_data_json` return the
same geometry and differ only in output format; `entity_data` reads attributes
and property sets instead, without tessellating.

```python
import ifclite_geom
import numpy as np

with open("model.ifc", "rb") as f:
    ifc_bytes = f.read()

data = ifclite_geom.geometry_data_buffers(ifc_bytes)

print(data["element_count"], "elements")
print("up axis:", data["up_axis"], "| units:", data["units"])
print("rtc offset:", data["rtc_offset"])

for step_id, el in data["elements"].items():
    verts = np.frombuffer(el["vertices"], dtype=np.float64).reshape(-1, 3)
    faces = np.frombuffer(el["faces"],    dtype=np.uint32 ).reshape(-1, 3)
    print(step_id, el["ifc_type"], el["global_id"], verts.shape, faces.shape)
```

Prefer no numpy dependency? Use the JSON variant, which returns the same data as
arrays of numbers:

```python
import ifclite_geom, json

doc = json.loads(ifclite_geom.geometry_data_json(ifc_bytes))
first = next(iter(doc["elements"].values()))
print(first["ifc_type"], first["vertices"][0])  # [x, y, z] in metres
```

## API

### `geometry_data_buffers(ifc_bytes: bytes, quality: str | None = None) -> dict`

The fast path. Vertices and faces come back as raw little-endian byte buffers so
you can hand them straight to `numpy.frombuffer` with zero parsing.

```text
{
  "up_axis": "Z",            # always Z (IFC native)
  "units": "m",              # always metres
  "rtc_offset": [x, y, z],   # geo-reference offset already folded into vertices
  "element_count": 1234,
  "elements": {
    <step_id:int>: {
      "ifc_type":  "IfcWall",
      "global_id": "3vB2...",   # may be None
      "name":      "Basic Wall:...",  # may be None
      "color":     [r, g, b, a],      # 0..1
      "vertices":  <bytes>,           # f64 little-endian, xyz triplets
      "faces":     <bytes>,           # u32 little-endian, triangle indices
    },
    ...
  }
}
```

Decode the buffers with:

```python
verts = np.frombuffer(el["vertices"], dtype=np.float64).reshape(-1, 3)  # (V, 3)
faces = np.frombuffer(el["faces"],    dtype=np.uint32 ).reshape(-1, 3)  # (F, 3)
```

### `geometry_data_json(ifc_bytes: bytes, quality: str | None = None) -> str`

The same geometry as a readable `ifc-lite-geometry-data` JSON document (a
string; call `json.loads` on it). Vertices are `[x, y, z]` arrays and faces are
`[a, b, c]` index arrays, so no numpy is required. Each element also carries
`global_id` and `name` when the source entity has them.

### Tessellation quality

Both geometry functions take an optional `quality` label:

| label | density | 
|---|---|
| `"lowest"` | quarter |
| `"low"` | half |
| `"medium"` | engine default, used when `quality` is omitted |
| `"high"` | double |
| `"highest"` | quadruple |

It scales the segment count on every curved primitive: swept-disk tubes,
cylinders, revolutions, arcs, circular profiles. On curve-heavy elements the
effect is large. A single `IfcReinforcingBar` authored as an `IfcSweptDiskSolid`
over a composite arc tessellates to 1056 triangles at `"medium"` and 96 at
`"lowest"`.

```python
data = ifclite_geom.geometry_data_buffers(ifc_bytes, "lowest")
```

An unrecognised label raises `ValueError` rather than silently falling back, so
a typo cannot cost you a 10x triangle budget without saying so. This is the same
knob the browser build exposes as `setTessellationQuality` and the server as
`?tessellation_quality=`; the level is model-wide, not per IFC type.

### `entity_data(ifc_bytes, placements=False, type_properties=True, attributes=True) -> dict`

Attributes, property sets and quantity sets. No tessellation runs, so this is
cheap compared with the geometry functions.

```text
{
  "length_unit_scale": 0.001,      # file length unit -> metres
  "plane_angle_to_radians": 0.0174,
  "project_id": 42,                # may be None
  "entity_count": 1234,
  "entities": {
    <step_id:int>: {
      "ifc_type":      "IfcWall",
      "global_id":     "3vB2...",       # may be None
      "name":          "WALL 1",        # may be None
      "description":   None,
      "object_type":   None,
      "has_geometry":  True,
      "placement":     None,            # see below
      "property_sets": [
        {"name": "Pset_WallCommon",
         "properties": [{"name": "IsExternal", "value": "True",
                         "value_type": "IFCBOOLEAN"}]},
      ],
      "quantity_sets": [
        {"name": "Qto_WallBaseQuantities",
         "quantities": [{"name": "Length", "value": 3000.0, "kind": "Length"}]},
      ],
      "attributes": [                  # schema-declared entity attributes
        {"name": "PredefinedType", "value": "SOLIDWALL", "value_type": "IFCENUM"},
      ],
    },
    ...
  }
}
```

`entities` is keyed by IFC STEP id in file order, the same key
`geometry_data_buffers` uses, so the two join directly. The join is one-way
total: every meshed element has a row, but not every row has an element, so
drive the loop from `elements` (or use `.get()`) rather than the other way
round. Besides products with no geometry, an orphan `IfcTypeProduct` carries
`has_geometry: True` and still never appears in `elements`, because the
geometry functions emit occurrences only.

```python
geom = ifclite_geom.geometry_data_buffers(ifc_bytes)
ents = ifclite_geom.entity_data(ifc_bytes)

for step_id, el in geom["elements"].items():
    row = ents["entities"].get(step_id)
    if row:
        print(el["ifc_type"], row["name"], row["property_sets"])
```

Pass `placements=True` to also resolve each product's `ObjectPlacement` into a
list of 16 floats: a **column-major** 4x4, translation in metres at indices
12/13/14. It is off by default because it costs an extra decode per product.

The matrix is in the **same absolute IFC world frame as
`geometry_data_buffers` vertices**, so the two line up directly. Do not fold
`rtc_offset` into either: the geometry export already adds it back into every
vertex, and the placement is never RTC-rebased. On a georeferenced model both
are large absolute coordinates, and a product's placement origin lands inside
its own mesh bounds.

#### Units, and two current limits

- **Property and quantity values are in the file's own units**, unlike geometry,
  which is always metres. A millimetre model reports a wall length of `3000`.
  Property values are always strings; quantity values are floats.

  Converting is per dimension, not one blanket factor:

  | quantity kind | to SI |
  |---|---|
  | `Length` | `value * length_unit_scale` |
  | `Area` | `value * length_unit_scale ** 2` |
  | `Volume` | `value * length_unit_scale ** 3` |
  | `Count` | unchanged (dimensionless) |
  | angles (properties) | `value * plane_angle_to_radians` |

  Only the length and plane-angle scales are resolved, so a model that declares
  an area or volume unit inconsistent with its length unit cannot be reconciled
  from what is returned here.
- **Only `IfcPropertySingleValue` properties are decoded.** Enumerated, list,
  bounded, table and reference properties are skipped; the pset still appears,
  with those entries missing.
### Entity attributes

Note the two senses of "type" on this page. The section below concerns an
`IfcTypeObject`, the shared definition an occurrence inherits from. This one
concerns the IFC **entity class** (`IfcWall`, `IfcReinforcingBar`) and the
attributes its schema declares. They are unrelated.

`attributes` is on by default. These are **not** property sets and no amount of
pset work surfaces them, because they are declared on the entity itself:

```python
row = ents["entities"][step_id]
{a["name"]: a["value"] for a in row["attributes"]}
# IfcReinforcingBar -> {'Tag': 'TAG-1', 'SteelGrade': 'B500B',
#                       'NominalDiameter': '29', 'CrossSectionArea': '660',
#                       'BarLength': '500', 'PredefinedType': 'NOTDEFINED',
#                       'BarSurface': 'PLAIN'}
```

Every IFC entity class has its own schema-declared attributes: `IfcDoor` yields
`OverallHeight` / `OverallWidth`, and so on, named and ordered as the schema
declares them. Entries share the `{name, value, value_type}` shape of a
property, so one code path reads both.

Fields the row already carries (`global_id`, `name`, `description`,
`object_type`) are not repeated, and reference-valued attributes are omitted
rather than rendered as a dangling `#123`. Pass `attributes=False` to skip.

### Type-inherited properties

`type_properties` is on by default. A type attaches its sets through
`IfcTypeObject.HasPropertySets` and gets no row of its own unless it carries
orphan geometry, so without this the properties authoring tools put on types
are unreachable. Each occurrence therefore also carries what it inherits
through `IfcRelDefinesByType`, merged **per property**:

- A type set whose name the occurrence does not use is added whole.
- A type set sharing a name contributes only the properties the occurrence does
  not already define. On a collision the occurrence wins, and the type-only
  properties beside it still survive. Replacing the whole set instead would
  hide them, which is the bug this rule exists to prevent.

**`quantity_sets` inherit on exactly the same terms.** A type attaches
`IfcElementQuantity` definitions through the same `HasPropertySets` attribute,
so they arrive by the same route and merge by the same rule: a type quantity
set the occurrence does not name is added whole, and a same-named one
contributes only the quantities the occurrence does not already define, so the
occurrence wins a collision. `type_properties` governs both lists; there is no
separate switch.

```python
# Own sets only, as in 4.3.0. Affects property_sets AND quantity_sets.
ents = ifclite_geom.entity_data(ifc_bytes, type_properties=False)
```

This mirrors what the browser has done since the same fix landed there, so a
property visible in the viewer is now visible here.

## Notes

- **One mesh per element.** Per-material submeshes of an element are merged into a
  single indexed triangle soup, keyed by its IFC STEP id.
- **Coordinates are absolute world metres.** The per-element local frame and the
  model RTC offset are folded back into every vertex. For geo-referenced models
  `rtc_offset` is non-zero; subtract it if you want f32-friendly local
  coordinates.
- **Welded and indexed.** Coincident corners are merged (1 micron grid), so
  closed-mesh consumers (volume, watertightness checks) work directly.
- **Occurrences only.** Type-product / RepresentationMap geometry is not
  emitted, matching what occurrence-based tessellators produce.
- **Errors** surface as `RuntimeError` (pipeline failure) or `ValueError` (an
  unrecognised `quality` label, or JSON serialization failure).

## Examples

Runnable scripts live in [`examples/`](./examples):

- [`quickstart_numpy.py`](./examples/quickstart_numpy.py) - load a file and
  inspect meshes via numpy.
- [`dump_json.py`](./examples/dump_json.py) - write the JSON document to disk.
- [`export_obj.py`](./examples/export_obj.py) - write every element to a single
  Wavefront `.obj` (numpy only, no extra deps).
- [`schedule_csv.py`](./examples/schedule_csv.py) - join `entity_data` against
  `geometry_data_buffers` and write a quantity schedule to CSV (stdlib only).

## License

MPL-2.0. Part of the [ifc-lite](https://github.com/LTplus-AG/ifc-lite) project.
