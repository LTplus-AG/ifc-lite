# IfcOpenShell differential parity harness

Out-of-band tooling: NOT a pnpm workspace package, NOT a Cargo workspace
member. It builds and runs only when its own CI jobs or a developer invoke
it. The geometry kernel's correctness was previously anchored to six numbers
hand-copied from one pip 0.8.2 run; this harness replaces them with a live,
re-runnable differential against a pinned reference engine.

## Layout

- `canonical.py` - every stat both sides report (bbox, tri/vertex counts,
signed volume, watertightness), computed from plain vertex/face arrays so
  the comparison measures geometry, never stat-computation differences.
  Known-answer unit tests in `test_harness.py` (stdlib unittest), including
  an `EndToEndFaultInjection` suite that perturbs an in-memory copy of a
  real committed reference dump and asserts `compare.py` actually exits
  non-zero - proof the "quick" CI lane's red path has teeth, not just that
  `classify()` is correct in isolation.
- `dump_reference.py` - canonical per-element JSON from the PINNED
  IfcOpenShell (world coords + welded, matching the provenance of the old
  baked constants). Engine failures become first-class `skip:<reason>` rows.
- `dump_ifclite.py` - the same schema from the shipped `ifclite_geom`
  binding (already welded, absolute-world, Z-up metres - apples-to-apples
  by construction; zero new kernel code).
- `compare.py` - joins by express id and classifies every element:
  `MATCH / MISMATCH / IFCLITE_ONLY / REFERENCE_ONLY / BOTH_SKIP`.
- `allowlist.json` - reviewed, accepted divergences with investigation
  notes; allowlisted rows report but do not fail.
- `reference/` - committed reference JSON for the hard corpus, generated
  with the pinned engine. Refreshing it (or bumping the pin) is an explicit,
  reviewed change.

## Gating policy (calibrated on real models, see compare.py docstring)

METRIC truth gates; topology is advisory. bbox within 1 mm and volume within
1% (both-closed, and only when physically plausible - a reported volume
exceeding its own bbox volume is a mixed-winding artifact and downgrades to
advisory). Triangle/vertex counts never gate: the engines legitimately
triangulate identical solids at different densities (duplex wall #5448 is
92 vs 308 triangles with identical bbox and volumes agreeing to 0.001%).

Signed volume uses one local bounds centre and compensated summation to avoid
world-origin cancellation at survey coordinates (#6533). A physical volume is
reported only for a closed mesh whose shared edges are traversed in opposite
directions. The `closed` flag retains its undirected edge-pairing meaning;
inconsistent winding yields `volume: null` and a `volume-unverifiable` advisory.
Global winding reversal preserves absolute volume. Open meshes still have no
volume evidence, and the bbox and 1% usable-volume gates are unchanged.

The [survey-volume evidence](evidence/survey-volume-6533.json) records the actual
Revit `rvt01.ifc` host #10191 replay using pinned IfcOpenShell 0.8.5, fixture and
geometry hashes, four quick-lane fixture checks, and independent negative
controls. The existing unittest entry point runs all new known-answer tests.
The two swept-disk references were regenerated with that engine: only their
volume eligibility and engine provenance changed. Their inconsistently wound
end caps are not a physical-volume oracle; no arbitrary recentered volume was
accepted. The full downloaded reference corpus was not regenerated here.

## Running locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.lock
# build + install the ifclite_geom wheel
.venv/bin/pip install maturin && .venv/bin/maturin build --release \
    -m ../../rust/python/Cargo.toml -o /tmp/wheels && .venv/bin/pip install /tmp/wheels/*.whl

.venv/bin/python -m unittest test_harness
.venv/bin/python dump_ifclite.py <model.ifc> --out-dir /tmp/lite
.venv/bin/python compare.py --reference reference/<model>.reference.json \
    --ifclite /tmp/lite/<model>.ifclite.json --allowlist allowlist.json
```

To replay #6533 after fetching `tests/models/various/rvt01.ifc` with `pnpm fixtures`,
run from this directory with the pinned engine installed:

```python
import hashlib
from pathlib import Path
import ifcopenshell, ifcopenshell.geom
import canonical

path = Path("../../tests/models/various/rvt01.ifc")
assert hashlib.sha256(path.read_bytes()).hexdigest() == "a83e9aacb43c7f82955ee3ba650ec66dc24af552924ec058e1b0c49a76180ee6"
model = ifcopenshell.open(str(path))
host = model.by_id(10191)
for disable_openings in (False, True):
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.WELD_VERTICES, True)
    settings.set(settings.DISABLE_OPENING_SUBTRACTIONS, disable_openings)
    shape = ifcopenshell.geom.create_shape(settings, host)
    vertices, faces = list(shape.geometry.verts), list(shape.geometry.faces)
    print(disable_openings, canonical.element_record(host.id(), host.is_a(), vertices, faces))
```

Regenerating the committed reference (pin bump or intentional acceptance):

```bash
.venv/bin/python dump_reference.py <models...> --out-dir reference/
```

## CI

Both lanes live in the `IfcOpenShell parity` workflow
(`.github/workflows/ifcopenshell-parity.yml`).

- Per-PR (`quick` job): ifc-lite side only vs the committed
  reference over the IN-TREE fixtures (no fixture download, no reference
  engine install). Catches kernel drift on every geometry-affecting PR.
- Nightly (`full` job): installs the pinned engine, runs the
  full committed corpus (fetched fixtures included), regenerates reference
  dumps to detect reference-staleness, and uploads the diff reports.
