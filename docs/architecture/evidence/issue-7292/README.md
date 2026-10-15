This directory retains independent surface evidence for issue #7292. `inputs.json` indexes historical reporter captures and five corpus entities. `corpus/source-inputs.json` records actual baseline and candidate production-module hashes; the recorded Git head alone does not attest a clean capture checkout. Existing reporter captures are historical until replaced by final source-built native/browser captures.

Use Python 3.12 with `ifcopenshell==0.8.5` and `shapely==2.0.7`. The single comparator rejects other engine versions and verifies fixture, cache, RTC, unit, and each native capture's own resolved placement. Fetch catalogued corpus fixtures with `pnpm fixtures` before replaying them. Reporter IFC bytes are already committed under `rust/geometry/tests/fixtures/`.

From this directory, replay a historical reporter capture without parsing IFC:

```sh
python compare_surface.py --candidate native-2pct.json --slope .02 --oracle-cache oracle-2pct.json --output /tmp/7292-reporter
```

Use `.05`, `native-5pct.json`, and `oracle-5pct.json` for the derived 5% case. `negative-2pct.json` must fail: the earlier bounded weld left a bottom-surface gap. Reporter comparisons retain all six analytic area/perimeter gates and 0.1 mm filled-surface containment. `--prepared-fixture <path>` consumes externally prepared stacked-layer IFC bytes exactly; it never reapplies the original slope transformation, and the cached fixture hash must match those bytes.

Replay a corpus case using its committed raw oracle arrays:

```sh
python compare_surface.py --mode corpus --fixture '../../../../tests/models/ara3d/S_Office_Integrated Design Archi.ifc' --base corpus/SOffice-868018/base --candidate corpus/SOffice-868018/candidate --oracle-cache corpus/SOffice-868018/oracle --output /tmp/7292-corpus
```

All geometry-derived plane groups, including unmatched native planes, are retained. Reporter meshes are Y-up positions plus origins with zero RTC; corpus meshes are IFC Z-up metres plus origins in their recorded RTC frame. The comparator keeps these frames explicit. Raw oracle files retain both IFC world coordinates and the independently recorded RTC subtraction.

Entities 868018, 869305, and 869947 pass full filled-surface containment at the existing 0.1 mm tolerance. Entity 92642 retains an existing 65 mm extent discrepancy and fails full conformance. Entity 9094 also retains existing oracle disagreements and fails full conformance. Both failing cases return exit code 1; their passing localized delta verdicts do not waive those failures. Entity 9094's changed coverage removes non-oracle material and restores oracle-required surface. Entity 92642's candidate preserves its baseline filled surfaces within tolerance.

Localized delta acceptance also compares new oracle-missing and oracle-excess sets against their previous sets at the same tolerance. This detects deletion of a required thin feature even when eroding the oracle would erase that feature. Boundary Hausdorff is diagnostic: an infinitesimal internal slit can have an outline far from the reference exterior while its filled surface remains within tolerance.

Polygon unions ignore overlapping multiplicity. These receipts make no winding, watertightness, or topological-closure claim. Full surface failure, localized delta, frame checks, and raw numeric measurements remain separate in each receipt. Browser capture metadata and images attest only their recorded source/runtime; native diagnostics are not browser evidence.
