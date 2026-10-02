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
