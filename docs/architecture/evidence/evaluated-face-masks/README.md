# Evaluated face masks and policy widening (#4404)

Native evaluated-occurrence planning now accepts a reviewed face mask per
product and any uniquely owned Body whose representation type permits
tessellation, not only mapped occurrences. The policy and the mask contract are
in [the representation policy](../../appearance-evaluated-occurrences.md).
This directory records the real AC20-FZK-Haus evidence for the native plan and
its independent reopening. It makes no browser, preview or timing claim; the
viewer's face-selection UI, split-part preview and browser acceptance are in
[`../evaluated-occurrences/face-mask-ui/`](../evaluated-occurrences/face-mask-ui/README.md).

## Native plan

[`native-mask-plan.json`](native-mask-plan.json) summarises the plan the
regression test writes for mapped IfcMember #35169 (one of 42 members sharing a
type) with the mask `[0, 1, 2, 3]` of its 12 canonical triangles. The mask is
bound to the `surfaceFingerprint` an unmasked plan of the same product reported.
The plan creates one shared `IfcCartesianPointList3D`, a four-triangle
`IfcTriangulatedFaceSet` that receives the image style, an eight-triangle
face set whose new `IfcStyledItem` points at the original source surface style,
and the ordinary image, style and UV-map rows. The only edited existing row is
the occurrence Body wrapper #35155 (`Tessellation`, Items = both face sets).
Every other canonical mesh, including sibling member #35304, compares exactly
before and after; the masked and retained face sets reproduce their share of
the source corners exactly and keep the source colour and material name.

Reproduce with the real fixture (`pnpm fixtures`):

```sh
IFCLITE_EVALUATED_EVIDENCE_DIR=/tmp/face-masks cargo test -p ifc-lite-processing \
  appearance::evaluated_mask --lib
python3 docs/architecture/evidence/evaluated-face-masks/verify-native-mask.py \
  tests/models/ara3d/AC20-FZK-Haus.ifc /tmp/face-masks/native-mask-planned.ifc \
  /tmp/face-masks/native-mask-plan.json /tmp/face-masks/independent-reader.json
```

The same test module covers, on a controlled extruded box, the policy widening
(a unique `SweptSolid` Body is refused under `preserve`, converted in place under
`evaluatedOccurrence`, and accepts a second direct appearance afterwards), the
split with both image and finite-page planning, the explicit refusals (stale
fingerprint, empty or out-of-range ordinals, direct tessellated Body, duplicate
or out-of-scope masks, masks under `preserve`), a whole-surface mask collapsing
to an ordinary conversion, and the fingerprint binding to the placed surface
rather than express ids: a renumbered export keeps it, an f32-exact 10 m move
keeps it, and an ordinary (12.345, 67.891, 0.1) m placement edit changes it so
the mask is reported stale, never reapplied. The real slab #34509 (`SweptSolid`,
no openings, Body referenced by its type map) converts with a cloned wrapper and
a single ProductDefinitionShape edit while the type map keeps the original
wrapper. The real post-opening slab #59290 (one opening, cloned type-shared
wrapper, rounding bounds on the cut corners) takes a 16-of-32 triangle mask: the
opening companion still travels, the edit set equals the unmasked conversion's,
both face sets share one point list, and the retained set reproduces exactly the
cut geometry the unmasked conversion authors (the IfcOpenShell run for the
masked slab is in the face-mask UI evidence linked above).

## Independent reopening

[`independent-reader.json`](independent-reader.json) is the output of
[`verify-native-mask.py`](verify-native-mask.py) with IfcOpenShell 0.8.3.post2
on this host. It confirms that only #35155 changed among the existing entities
(comparing entity text after recovering the native test writer's raw UTF-8
strings), that all 41 sibling members of the shared type tessellate to the same
IfcOpenShell world vertices and faces before and after (a geometry digest per
sibling, not an id count), that no new schema finding appeared relative to the source's 170
existing findings, that the textured face set carries the `IfcSurfaceStyleWithTextures`
and the single `IfcIndexedTriangleTextureMap`, that the retained face set keeps
the original surface style entity #17391 with no texture map, that both face
sets share one point list, and that the authored world corners match the
canonical native source snapshot exactly (zero metres for both face sets). The
reader tessellates the reopened product into the same 12 triangles with zero
nearest-corner distance to the native source. This is a sampled corner
comparison, not a Hausdorff proof.

## Performance

[`native-load.json`](native-load.json) is the interleaved, order-balanced
base-versus-branch native normal-load probe on AC20 (nine rounds per side,
prebuilt `profiling` binaries, the `ab.sh` method driven through
`scripts/perf/ab-order.mjs` with seed 4404 because its CLI guard prints
nothing on Windows). Every phase median is equal or within two milliseconds and
inside the reporter's noise band; the reporter withheld a verdict because the
base's own spread exceeded its 15% threshold on a machine shared with other
builds. [`native-fingerprints.json`](native-fingerprints.json) compares a
`--fingerprint` run of both binaries: identical mesh, vertex and triangle
counts and identical ordered geometry fingerprints. The ledger row "Evaluated
face masks and tessellatable-body policy (#4404)" in `scripts/perf/README.md`
records the verdict and its limits. Face masks and the widened policy run only
inside an explicit appearance plan; ordinary loading does not touch them.
