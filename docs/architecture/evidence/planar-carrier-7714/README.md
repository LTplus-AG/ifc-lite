# Bounded adjacent-carrier normalization (#7714)

The source witness is SOffice operand `IfcFacetedBrep` #489635. Its original
file SHA256 is `38c4ecbbc67d0759dfcffb2c90664f5b5231e6c48fc54597c62975b41bb629db`.
The committed `rust/geometry/tests/fixtures/issue_7714_soffice_carrier.ifc`
contains its exact shell/face/bound/loop/point records with reduced project,
context and product scaffolding. Tests also read the original fetched file.

The existing carrier of face #489589 contains three noncollinear corners of
warped face #489621, and the faces share an authored edge. Its intersection
with the other healthy incident planes corrects source point #489593 from
`(95.0001680875, 11845.0000131, -325)` to `(95, 11845.0000131, -325)` in
millimetres. The carrier retains its slope; this is not an X=95 plane fit.
All uses of the shared point change together. Source bytes and decoder point
caches remain unchanged.

The first domain requires one project and one explicit SI length unit, one
owned 3D root context and direct inherited subcontexts, valid representation
context references, and unit mapped scales. No default Precision is inferred.
The parent rule follows EXPRESS
[ParentNoSub](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcGeometricRepresentationSubContext.htm).
Unknown, incomplete or conflicting provenance declines.

The transaction is bounded to 32 single-bound faces, 64 distinct point IDs and
128 corners. Exact binary64 rational arithmetic selects an existing carrier,
requires a unique consistent intersection of all incident constraints, bounds
movement by declared Precision, and requires the correction to be exactly
representable in binary64. It validates source-ID edge incidence, vertex links,
nonzero edges, face orientation, positive volume and convex supporting planes.
On each carrier, convex finite faces must have disjoint interiors and exactly
cover their supporting hull. This rejects coplanar holes and double coverage.
Every check precedes publication; a decline keeps the established mesh path.

Potentially normalized items in the bounded face/bound domain retain
model-scoped source identity in pre-mesh fingerprints,
including shared memo hits, Boolean parents and generic BREP hash fallback.
Coordinate-identical items with different sharing cannot reuse a repaired mesh.
Ordinary planar BREP structural reuse remains available. The existing #3988
two-face, multi-bound scratch-buffer counterexample keeps structural reuse.
Commented records consult the same bounded source-topology admission; the
existing tokenizer and first-reference helpers remain unchanged from base.

The independent probe imports IfcOpenShell, Fraction and Shapely, never ifc-lite:

```sh
python tools/ifcopenshell_reference/probe_carrier_7714.py \
  'tests/models/ara3d/S_Office_Integrated Design Archi.ifc'
```

IfcOpenShell 0.8.5 retains the original warped corner in its direct-item mesh.
Its fitted internal carrier is a different policy from this authored adjacent
carrier. This work claims no OCC equivalence, direct-item-to-product tolerance
transfer, actual product Boolean branch selection, or repair of the separate
already-planar #798142 weld-admission case. Kernel NearBand and oracle thresholds
are unchanged.

Native worker-pool timings, real WASM boundary tests, and physical-GPU browser
cohorts are separate evidence. A source build does not establish a GPU result.

`source-oracle-breps.json` extends the first receipt with the retained 0–2
triangles and hashes of independently serialized item/product BReps.
`oracle-counterexample.ndjson` preserves both raw serializations as gzip/base64,
all plane records, the exact adjacent carrier and the mixed product tolerances.
To reproduce these raw receipts, add `--brep-dir /tmp/carrier-7714-breps` to the
probe command above. Decode each `serialized_brep` row with
`gzip.decompress(base64.b64decode(row["raw_gzip_base64"]))`; SHA256 must equal
that row's `sha256`. These are observational receipts, never acceptance bands.
