# Rigid map placement normalization — #6692

The opt-in rigid path changes original root LocalPlacement frames, retains child
placement and representation identities, and neutralizes the map operation.
It applies only at exactly unit physical scale. Other scaling uses the stricter
mapped-Body path. This evidence covers source `c8e85def040308c1ce4d52000373e53536590b6c`;
the subsequent unused-context regression, provenance move and fixture-policy
follow-ups change no production code.

## Independent source oracle

IfcOpenShell 0.8.2 checked the authored map affine multiplied by every original
product frame against the emitted frame: all 2,668 MiniBIM products and 127 Haus
products retained GUIDs, placement IDs and representation IDs. Maximum frame
coefficient errors were 5.82e-11 and 9.31e-10, respectively. The native fixture
tests reproduce frame, source-record and selected physical surface invariants.
They require `pnpm fixtures` and skip only when the catalogued fixture is absent.
With `IFC_LITE_REQUIRE_FIXTURES=1`, all 19 current planner tests pass with
fixtures present. An isolated missing-fixture check runs the actual product
oracle: optional mode skips with the `pnpm fixtures` instruction; required mode
fails (exit 101). Both scratch fixture links were restored. The shared fixture
loader owns this policy; UTF-8 decoding failures remain explicit.

[MiniBIM provenance and complete license](../georeferencer-mini-bim/README.md)
accompany the unmodified public producer fixture; IFC bytes are not committed.

Source CSG may retriangulate: Haus wall #17040 changes 20 vertices/36 faces to
25/46. Independent bidirectional vertex-to-triangle surface distance is about
11 micrometres, rather than the misleading 12-centimetre nearest-vertex distance.
The native oracle samples vertices and triangle centroids, requires the actual
opening cut, checks surface area, and retains GUID/Name/style ownership.

## Committed real-WASM boundary coverage

CI exposed two outdated exporter assertions that the earlier local native and
scratch boundary runs had not exercised. This was a local boundary-test coverage
gap, not a CI flake. Genuine unit-scale rotations, including an ordinate just
above `f64::EPSILON`, now assert unsnapped affine placement and immutable source,
edits and orphan geometry; nonunit-scale refusals remain tested. Modified entity
accounting is derived from actual changed original IDs, separately from new IDs.

The committed exporter fixture contract authors 15°/50° map operations in memory
on the original catalogued MiniBIM/Haus files. It checks all 2,668/127 product
identities and placement/representation references, changed root frames,
canonical neutral map attributes, retained CRS/map units, selected edits, and
ordinary-export immutability. Bounded real geometry batches check sampled mesh
identities, retained colors and bidirectional vertex/triangle-centroid surface
distance for three distinct opening hosts and a door per model. MiniBIM also
checks every host in the changed CSG diagnostics described below:

Geometry batches use the existing whole-file prepass, style/finish/material/void
metadata and canonical RTC/conversion helpers, then filter only the actual sampled
job IDs. This retains whole-file export and product-reference assertions without
running unrelated thousands of CSG jobs twice; the earlier whole-model geometry
test exceeded its 180-second deadline on CI. No timeout increase, fixture skip or
production pipeline change is used. The API, prepass cache and mesh handles are
freed in `finally`, including assertion/error paths. The sampled physical surface
tolerance is 3 mm; this is not whole-model geometry or exact mesh identity proof.

| Fixture | Sampled ExpressIds | Maximum surface distance |
| --- | --- | --- |
| Haus | 17040, 18698, 21966, 17468 | 0.000010791 m |
| MiniBIM | 135719, 135923, 137489, 136868, plus the diagnostic hosts below | 0.000288835 m |

Before this all-affected expansion, the full root Turbo exporter suite passed
1,731 tests across 142 files with one existing skip. The final bounded boundary
files passed 14/14 with zero skips in 15.68 seconds, using required fixture mode
and the accepted `f2114e…` runtime verified before and after the run. Root
typechecking covered all 3,301 test files. These authored-map fixture tests complement, rather than
replace, the actual downloaded writer-file/provider acceptance below.
In an isolated checkout with both fixture paths absent, optional mode skipped
both tests with the download/build instruction; required mode failed both
direct missing-fixture assertions after successful dependency builds.

## Changed CSG diagnostics and all-affected controls

MiniBIM's CSG diagnostics change from 13 failures across three hosts
(11 `KernelError`, two `NoBoundsOverlap`) to 14 across seven hosts
(eight `KernelError`, six `NoBoundsOverlap`). Those counts alone are not a
physical preservation verdict. The isolated comparison therefore checked **all**
affected hosts: 135923, 200207, 147941, 201198, 148007, 201979 and 202696.
The committed WASM fixture test now includes this entire set, with deduplication
and explicit nonempty source/output meshes.

[Compact physical controls](diagnostic-host-controls.json) record canonical RTC
reconstruction, the authored 15° affine, bidirectional vertices and triangle
centroids, and controls removing only these hosts' `IfcRelVoidsElement` records.
Newly reported wall hosts differ by at most 0.000011821 m; slab 135923 differs by
0.000288835 m and retriangulates from 999 to 708 triangles. Signed triangle sums
subtract a nearby point before triple products; they are not claimed to be
watertight-certified volumes or computed from raw RD/UTM absolute coordinates.

Independent **IfcOpenShell 0.8.2** controls, with opening subtraction enabled and
disabled, give the same physical area and volume on all seven hosts (maximum
differences 7e-13 m² and 5.7e-14 m³). The slab already has 14 profile inner loops;
the walls' polygonal face sets have no `IfcIndexedPolygonalFaceWithVoids` faces.
For these particular hosts the listed opening relationships remove no additional
material. No lost material-removing cut was found; finite-precision and
retriangulation differences remain. This does not prove every MiniBIM surface.

To reproduce the independent source control with the catalogued fixture present:

```sh
python3 docs/architecture/evidence/rigid-map-6692/diagnostic-opening-controls.py
```

The script requires `ifcopenshell==0.8.2`; fetch the IFC via `pnpm fixtures`.

## Actual browser and provider acceptance, 2026-10-02

Fresh first-load tabs at the frozen production preview loaded the original
georeferencer downloads, not pre-normalized native files. The ordinary Cesium
ion dialog uploaded them without request interception or provider overrides.
The served runtime SHA-256 was
`f2114e3871688663bf7f57fe1e1f9fbf28f10c9e06948ecfa54c7809859deab4`.

| Writer output | Source SHA-256 | Actual asset | Result |
| --- | --- | --- | --- |
| MiniBIM rotation 15° | `d58bf864378950d7e673b3c3c90435d994dccce1d91a7f418da34a8680049c2f` | 5974905 | COMPLETE 100%, 17 decoded GLBs, 7 GUID-matched surface samples, maximum 0.001590 m |
| Haus anchor 50° | `153d0354432a4d494759ece6b7ab0f51142acc37ee3e180f46cd61524d6cbe10` | 5974907 | COMPLETE 100%, 5 decoded GLBs, 8 GUID-matched Wall/Door/Slab/Window samples, maximum 0.001004 m |

The neutral Haus provider control (5974759) and rotated output (5974907) both
contain the same 83 `(ExpressId, GlobalId)` product identities and 21,650
LOD-inclusive triangles. MiniBIM neutral, adapted GeoBIM control and candidate provider outputs also
retain the same 1,897 product identities. Point counts differ; no byte or topology identity is
claimed. Both actual Cesium SDK tilesets reached `tilesLoaded`. Numeric authored height
bounds errors were at most 0.000612 m and 0.000744 m; this does **not** prove a
vertical datum transformation. Surface acceptance is bounded to the listed
sampled products, not every provider LOD. T3 screenshot capture failed with a
client error: no fresh screenshot or visual inspection is claimed. The original
unavailable discussion model was not tested. Credentials are absent from evidence.

## Supported semantic mutations

These reverse patches preserve all API and test module registrations. In an
isolated checkout of the recorded source, run the repository-supported oracle:

```sh
node scripts/check-test-revert-oracle.mjs \
  --base caf0c3077bf3b132fc60a6805eb849580d6fd5db --head HEAD \
  --mutation docs/architecture/evidence/rigid-map-6692/dispatch.reverse.patch \
  --test rust/export/src/step_map_rigid_tests.rs --json
```

Repeat with the other patches. Each observed run had an attributable 7/7 green
baseline and verified byte-identical restoration. Dispatch removal caused six
assertion failures; unrotated TrueNorth, depth-32 acceptance and replacing the depth-specific refusal with a generic
unsupported report each caused one assertion failure. All four verdicts were **OBSERVED**.
The bound and its report are tested separately. The whole-file CI revert removed
new test module registrations and was **INCONCLUSIVE**, not a semantic pass.
