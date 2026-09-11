# Evaluated face masks and policy widening (#4404)

Native evaluated-occurrence planning now accepts a reviewed face mask per
product and any uniquely owned Body whose representation type permits
tessellation, not only mapped occurrences. The policy and the mask contract are
in [the representation policy](../../appearance-evaluated-occurrences.md).
This directory records the real AC20-FZK-Haus evidence for the native plan and
its independent reopening. It makes no browser, preview or timing claim: the
viewer's split-part preview and face-selection UI are a separate slice, and its
preview binder refuses a masked plan explicitly until then.

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
to an ordinary conversion, and the fingerprint following geometry rather than
express ids or a rigid placement move. The real slab #34509 (`SweptSolid`, no
openings, Body referenced by its type map) converts with a cloned wrapper and a
single ProductDefinitionShape edit while the type map keeps the original wrapper.

## Independent reopening

[`independent-reader.json`](independent-reader.json) is the output of
[`verify-native-mask.py`](verify-native-mask.py) with IfcOpenShell 0.8.3.post2
on this host. It confirms that only #35155 changed among the existing entities
(comparing entity text after recovering the native test writer's raw UTF-8
strings), that no new schema finding appeared relative to the source's 170
existing findings, that the textured face set carries the `IfcSurfaceStyleWithTextures`
and the single `IfcIndexedTriangleTextureMap`, that the retained face set keeps
the original surface style entity #17391 with no texture map, that both face
sets share one point list, and that the authored world corners match the
canonical native source snapshot exactly (zero metres for both face sets). The
reader tessellates the reopened product into the same 12 triangles with zero
nearest-corner distance to the native source. This is a sampled corner
comparison, not a Hausdorff proof.

## Performance

[`native-load.json`](native-load.json) is the interleaved base-versus-branch
native normal-load probe (`scripts/perf/ab.sh`, five rounds per side, AC20).
The verdict and its limits are recorded in the ledger row
"Evaluated face masks and tessellatable-body policy (#4404)" in
`scripts/perf/README.md`. Face masks and the widened policy run only inside an
explicit appearance plan; ordinary loading does not touch them.
