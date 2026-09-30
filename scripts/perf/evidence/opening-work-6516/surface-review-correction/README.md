<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Distance reproducer correction — PR #6536

The old calculation reported a squared distance of approximately 1.11e-11 m²
for the centroid of the triangle `(0,0,0), (1000,0,0), (1000,1e-5,0)`, even
though the centroid is on its surface. Its nearly equal Gram products cancelled,
so the interior was rejected and only edge distances remained. Cross-product
barycentric coordinates preserve that interior; normal projection supplies its
plane distance. Zero-area triangles still fall back to their segments.

The old sampling also included unused buffer positions. A fourth unreferenced
vertex at `(1e6,1e6,1e6)` now leaves the triangle's samples, bounds and volume
reference unchanged. These are independent geometric known answers, run by:

```sh
python compare-surfaces-6516.py --checks-only
```

The nine complete comparison JSON files here were freshly generated from the
same archived capture and pinned IfcOpenShell reference bytes. Each records all
six directed comparisons and all three sample sets, input and metadata hashes,
coordinate adapters, geometry diagnostics and the final reproducer hash.
`invocations.json` records the actual CLI arguments; its local paths identify the
original archived inputs, whose hashes are embedded in each output. Reconstruct
inputs using the collectors and coordinate procedures in the parent evidence
directory; the large capture arrays are not committed model fixtures.

`native-rvt14-changed-parts.json` separately reruns both directions on every
changed native Revit part in the same recorded SiteLocal frame. All 14 retain
closed, coherent edge incidence; the largest finite-point difference remains
about 13.73 µm. It adds no external-oracle or world-frame claim for that native
capture. Some formerly reported small differences were numerical artefacts:
the corrected 455 base-versus-candidate finite-point maximum is about 4.82e-14 m.
That does not establish continuous surface equality or valid solid topology.

Earlier distance reports and their hashes remain historical evidence. These
outputs supersede their derived distances; they do not replace performance runs,
production meshes or topology acceptance checks. Public 455 still has an existing
approximately 1.25 mm worst reverse sample discrepancy against its independent
reference, and the ISSUE_068 candidate remains slightly farther from its reference
in its worst forward sample. The limited correctness and noisy performance
verdicts have not become broader claims.
