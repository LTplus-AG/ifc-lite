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
