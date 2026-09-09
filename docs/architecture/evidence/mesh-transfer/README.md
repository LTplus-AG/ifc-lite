# Registered mesh-transfer foundation (#4381)

This slice adds native/WASM planning, not a new UI command or a measured real
scan registration. It composes a registered opaque image observation over the
existing target appearance through the same atlas and IFC material planner used
by finite pages. Gaps remain explicit unknown observations.

The [independent run](oracle.json) invokes actual rebuilt WASM, applies its typed
mutation plan through IfcOpenShell, serializes/reopens IFC, checks independent
geometry, decodes PNG with Pillow and evaluates UV/color samples with NumPy.
The controlled 1 m triangle has a smaller observed triangular patch. Four source
image quadrants distinguish U/V orientation; an uncovered point retains its
explicit original RGB. The source is a declared invariant fixture, not a real
scan/IFC pair. Five interior/background samples pass a 0.025 normalized-channel
ceiling; the actual worst delta is recorded in JSON.

Native invariants additionally reject thin-wall look-through, overlapping source
faces and UV-seam ambiguity, while allowing continuous shared edges. They check
partial coverage area accounting, real IFC/PNG reopen, missing/stale identity,
unsupported alpha/tint, reflected placement, changed pixels and exhausted work.
The actual WASM contract repeats coverage, payload binding, no-applicable-plan
and refusal checks. Existing page composition tests protect source appearance,
previously applied pages and material properties through the shared refactor.

Reproduce after `bash scripts/build-wasm.sh`:

```sh
cargo test -p ifc-lite-processing appearance::transfer --lib
pnpm test:wasm-contract
python3 tools/texture-authoring/mesh-transfer-oracle.py
```

The oracle needs IfcOpenShell, Pillow and NumPy installed locally. It does not
fetch assets or provide an application IFC writer. Browser acceptance, source
lease/frozen-frame wiring, ordinary Apply/Undo/export/share and real distributed
held-out correspondences remain separate gates under #4381. CRAS plane-support
evidence does not supply those missing correspondences.

## Real boulder geometry: conservative coverage and capacity

The public CC0 albedo-only boulder GLB already qualified for captured-mesh
creation supplies 66,122 source triangles. This probe uses the existing captured
IFCZIP from [the portability acceptance](../captured-room/README.md), with a
40,087-triangle proxy. It first verifies that target coordinates are the known
Y-up→Z-up conversion of that exact GLB. The four fit/four check observations are
therefore **known-derived controls**, not independent scan/BIM correspondences.
The embedded fit residuals measure that control transformation only.

[The complete target](boulder-full.json) refuses the aggregate BVH work budget;
it produces no partial mutation plan. This foundation does not yet qualify
model-wide transfer at that size. A future measured optimization should reuse
conservative candidates across target tiles/triangles while preserving unknown
coverage and one final atomic Apply; raising the cap is not the acceptance gate.

[The first 500 target triangles](boulder-prefix-500.json), retaining original
coordinates and parallel UV maps, complete within the same bounds. The sampled
area estimate is about 77% observed. Of 22,915 centroid/interior samples, 5,538
are ambiguous; no samples fail distance or normal criteria in this measured prefix. Exact coplanar UV-continuous
neighbors are exempt from ties; curved facets and seams remain conservative
unknowns. This result is a bounded prefix measurement, not full-boulder coverage
or proof of smooth-surface continuity. The preserved old boulder image supplies
unknown albedo. Source and effective derived IFC identities are in each report.

Reproduce with the existing qualified GLB and captured IFCZIP:

```sh
python3 tools/texture-authoring/boulder-transfer-probe.py source.glb captured.ifczip
python3 tools/texture-authoring/boulder-transfer-probe.py source.glb captured.ifczip 500
```

The script is deliberately a hash-qualified offline evidence decoder, not a new
application ingest path. It requires SciPy as well as the oracle dependencies.
