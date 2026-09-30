# Independent surface qualification for #6516

`compare-surfaces-6516.py` is an offline evidence reproducer. It does not run a
performance benchmark or change a geometry acceptance threshold. NumPy 2.0.2
and CPython 3.12.14 produced the recorded runs. The reference meshes came from
IfcOpenShell 0.8.5, pinned by `tools/ifcopenshell_reference/requirements.lock`.

The script first checks known triangle interior, edge, endpoint and degenerate
segment distances, then compares 100 scalar and 100 batched BVH queries against
full-triangle brute force. Actual model checks query every unique vertex,
triangle centroid and unique edge midpoint, in both directions. Referenced
vertices seed upper bounds only; reported distances are to triangle surfaces.
Its output includes source/input/metadata hashes, coordinate provenance,
triangle counts, exact-coordinate edge incidence, and centered signed volume.

Run the method checks independently:

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python compare-surfaces-6516.py --checks-only
```

Capture the pinned-engine reference in world metres, using an unmodified public
IFC whose hash is recorded in the evidence:

```python
import json
import ifcopenshell
import ifcopenshell.geom

assert ifcopenshell.version == '0.8.5'
model = ifcopenshell.open('model.ifc')
settings = ifcopenshell.geom.settings()
settings.set(settings.USE_WORLD_COORDS, True)
settings.set(settings.WELD_VERTICES, True)
settings.set(settings.DISABLE_OPENING_SUBTRACTIONS, False)
shape = ifcopenshell.geom.create_shape(settings, model.by_id(HOST_ID))
with open('oracle.json', 'w') as output:
    json.dump({'verts': list(shape.geometry.verts), 'faces': list(shape.geometry.faces)}, output)
```

Repeat with opening subtraction disabled for a separate host-solid reference.
Both inputs are useful; equal aggregate volume alone does not prove openings
leave the surface unchanged.

Compare canonical browser or Node geometry arrays:

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python compare-surfaces-6516.py \
  --base base.json --candidate candidate.json --oracle oracle.json \
  --host-id 81962 --output surface-result.json
```

Each browser capture is `{ "coordinateInfo": ..., "meshes": [...] }`. Meshes
carry `id`, `positions`, `indices`, `origin`, and the original attributes needed
for independent identity checks. Positions/indices may be arrays or
`{ "values": [...] }` captures. Canonical arrays are already metres and Y-up;
the adapter reverses `[x,z,-y]`, adds each mesh origin, and adds the actual IFC
RTC frame. It does not reapply `lengthUnitScale` or `buildingRotation`. It refuses
nonzero `originShift` because those need a separately audited adapter.

Node captures can instead be a mesh array plus the actual canonical streaming
events in JSONL, supplied with `--base-metadata` and `--candidate-metadata`.
The tool reads the `complete` event's coordinateInfo, not an assumed RTC. This
matters on rvt01: canonical Node RTC Z is **14.73 m**, while the native
ModelFrame collector below uses **14.23 m**. Part origins compensate; mixing
the two collectors silently misplaces geometry by half a metre. Whole-entity
bounds were independently checked against the reference before comparison.

For the explicitly RTC-configured native ModelFrame collector used in these
runs, pass `--base-kind native-model-frame --candidate-kind native-model-frame`.
Its capture is `{ "axis": "IFC Z-up", "id": ..., "positions": [...],
"indices": [...], "origin": [...], "rtcOffset": [...] }`. The adapter adds
positions + origin + actual RTC. A standalone `rtcApplied` flag is recorded,
and does not by itself establish the collector's coordinate contract.

Selecting a host with multiple material parts compares the union of all
captured triangle surfaces, including internal layer interfaces. The recorded
Revit qualification also compares corresponding individual parts separately,
so unchanged outer bounds cannot conceal a reopened material part.

The portable script was checked against the original independent Snowdon and
ISSUE_068 runs: every sample count, distance quantile/maximum, and threshold
count matched exactly. The original failed script attempt (missing helper
function) was retained and corrected before using its results.

Limits: these finite samples do not prove continuous Hausdorff bounds. Closed
coherent edge incidence does not prove a valid solid against self-intersections
or incorrectly nested components. Signed volume remains diagnostic. Separate
real-WASM, later-cut occupancy, full-corpus topology and output identity tests
cover different failure modes. On public455 the existing worst reverse distance
to IfcOpenShell is about 1.25 mm in both sources; this evidence does not claim
submillimetre agreement everywhere. ISSUE_068 candidate's worst forward sample
is slightly farther from the reference, and is explicitly recorded.
