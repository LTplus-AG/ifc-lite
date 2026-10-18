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
All uses of the shared point within that shell change together. Source bytes and decoder point
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


The integrated implementation is qualified at
`f66a8d07648e354b8d488f760fce712257ff2759` on base
`c53cfaa3a2034638f4c4ab40f7674b29e0528fed`. The follow-up evidence commit
changes documentation and the perf ledger; it does not change that Rust/TS source.
`qualification.json` records actual commands, counts, runtime/wheel identities and
limits. The initially unstaged model844 wheel case is recorded separately from
its successful targeted fixture recheck. Existing parity thresholds, allowlist,
WASM types and both deterministic manifests remain unchanged.

`functional-raw.ndjson` retains complete logs and worker/source receipts.
`regression-controls.json` and `regression-raw.ndjson` retain the semantic #3988
hash regression, malformed-record failures, canonical-record red control and
cache-sharing mutant. The original #3988 assertion was preserved. The first
canonical-record control accidentally reused a newer executable through a shared
Cargo target; that invalid green is retained with its classification and the
separate-target, actually compiled red control. Historical source-only reviews
are tagged with their own source pins and are not runtime reviews of this pin.

`initial-96d018a66-cohort.ndjson`, its summary and lossless raw logs retain
the initial regressing cohort. Its base, source and sampling plan differ from the final cohort; its
kernel-failure event count did not retain a reason census and must not be read as
a count of newly broken products. The final source-index certificate caches both
success and decline across fresh decoders. Cache admission shares the bounded
necessary-carrier test with normalization, preserving the out-of-domain
structural-reuse counterexample.

`performance-cohort.ndjson`, `performance-summary.json` and `performance-raw.ndjson`
record the final interleaved native worker-pool cohort. Raw receipts include the
fixture/source/executable hashes, admission and idle checks, source cleanliness,
all samples and output counts/fingerprints. Phase summaries use the probe's best
iteration and the median across the declared process blocks; wall summaries use
all iterations. File reading and verification fingerprints are outside that wall
clock. This is a native CPU cohort; the attached preview returned no WebGPU
adapter, so there is no physical-GPU browser timing verdict.

Ordered mesh-payload fingerprints cover product/item IDs, class, positions,
normals, indices, colour, origins, bounds and transforms. They do not certify the
entire ProcessingResult, text, material definitions, UVs/textures or instancing
metadata. The per-product diagnostic records the exact changed product and
retains the other failure hosts. The source-built wheel output is checked for
finite/nondegenerate triangles, closed opposite-edge incidence and positive
volume of the actual final product; its loaded native library matches the
newly built wheel. These invariants do not establish OCC equivalence or actual
Boolean operand-branch selection.

Each raw-log row has `encoding: "gzip+base64"`, `raw`, `bytes` and `sha256`.
Decode with `gzip.decompress(base64.b64decode(row["raw"]))` and verify both
length and SHA256. The earlier oracle-counterexample rows retain their documented
`raw_gzip_base64` field. Reproduce those historical oracle receipts in an isolated
IfcOpenShell 0.8.5 environment; current committed-reference parity used its
separate requirements environment and IfcOpenShell 0.9.0.post1.

The cohort executes the already built canonical `perf_probe` executable for
each revision directly, with the same runtime arguments as the root probe:

```sh
/absolute/private/target/profiling/examples/perf_probe /absolute/path/to/fixture.ifc --iters 5 --fingerprint --json
```

The original unrun driver called `probe.sh`, which unconditionally invokes
Cargo. Its replacement and intermediate variant are retained with their hashes.
The executed driver is `631e967e8b6c4c222230179caabecaa22820589dcefc1f3ac325eff7fc18e7ca`;
no build, install or Cargo command runs inside measurement admission.

The retained manifest defines the balanced revision order, fixture set, worker
count and block count. Matching binaries are built as ordinary work before the
otherwise-idle exclusive cohort. Obsolete `bf72` reservation `07ba51f7` was sealed
and cancelled while queued; its original terminal receipt is retained and no
measurements are attributed to it. No peer resources or admission gates were
changed.


The final worker receipt is completed with exit zero and unchanged source. All
per-process idle/admission checks passed. `performance-verdict.json` records the
honest result: Haus and Holter regress in phase total and wall time, while
SOffice improves in phase total but regresses in wall time. ISSUE_129 decreases
in both. The two balanced process blocks do not establish statistical
significance or justify dismissing an adverse result as noise. There is no
overall speed or neutral-performance claim; performance acceptance remains open.
All control-fixture mesh counts and payload hashes are identical across runs and
revisions. SOffice has the expected sole product change. These results are
measurements of this source/base pair, separate from the historical regression.


`post-measurement-source-equivalence.json` records the later nonproduction
restack: runtime/test trees, manifests and locks remain byte-identical to the
measured source, and all measured executable hashes remain unchanged. The core
follow-up adds a supported surgical certificate-cache mutation and an explicit
restored-positive command to the existing observation gate; it changes no
filters or lane requirements. The fixture coverage ledger is regenerated by its
existing generator. `hosted-checks.json` and lossless hosted logs preserve the
actual pre-repair failures. The new workflow's assertion RED and restored-positive
qualification remain pending hosted execution; the historical cache mutant
is not substituted for that result. The upper stack's missing main-only lanes,
the viewer-entry bundle ceiling and performance acceptance remain barriers.
The parent owns ordered landing; no stack layer is retargeted to bypass gates.
