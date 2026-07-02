# Python API Reference

`ifclite-geom` is a native Python wheel that runs ifc-lite's Rust geometry
kernel in-process. It turns an IFC file into per-entity triangle meshes with no
Node, no WASM, and no subprocess.

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

The module is `ifclite_geom` and exposes two functions. Both take the raw IFC
file as `bytes` and return the same geometry; they differ only in output format.

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

No numpy? Use the JSON variant, which returns the same data as arrays of numbers:

```python
import ifclite_geom, json

doc = json.loads(ifclite_geom.geometry_data_json(ifc_bytes))
first = next(iter(doc["elements"].values()))
print(first["ifc_type"], first["vertices"][0])  # [x, y, z] in metres
```

## Functions

### `geometry_data_buffers(ifc_bytes: bytes) -> dict`

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
      "global_id": "3vB2...",          # may be None
      "name":      "Basic Wall:...",   # may be None
      "color":     [r, g, b, a],       # 0..1
      "vertices":  <bytes>,            # f64 little-endian, xyz triplets
      "faces":     <bytes>,            # u32 little-endian, triangle indices
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

### `geometry_data_json(ifc_bytes: bytes) -> str`

The same geometry as a readable `ifc-lite-geometry-data` JSON document (a string;
call `json.loads` on it). Vertices are `[x, y, z]` arrays and faces are
`[a, b, c]` index arrays, so no numpy is required. Each element also carries
`global_id` and `name` when the source entity has them.

## Notes

- **One mesh per element.** Per-material submeshes of an element are merged into a
  single indexed triangle soup, keyed by its IFC STEP id.
- **Coordinates are absolute world metres.** The per-element local frame and the
  model RTC offset are folded back into every vertex. For geo-referenced models
  `rtc_offset` is non-zero; subtract it for f32-friendly local coordinates.
- **Welded and indexed.** Coincident corners are merged (1 micron grid), so
  closed-mesh consumers (volume, watertightness) work directly.
- **Occurrences only.** Type-product / RepresentationMap geometry is not emitted.
- **Errors** surface as `RuntimeError` (geometry pipeline failure) or
  `ValueError` (JSON serialization failure).

## Examples

Runnable scripts live in the
[`rust/python/examples/`](https://github.com/LTplus-AG/ifc-lite/tree/main/rust/python/examples)
directory: a numpy quickstart, a JSON dump, and a Wavefront `.obj` exporter.

## Source

The binding is a thin PyO3 layer at
[`rust/python`](https://github.com/LTplus-AG/ifc-lite/tree/main/rust/python),
wrapping the same `process_geometry` pipeline used by the viewer and server.
