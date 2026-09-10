# Evaluated opening appearance (#4404)

The opt-in evaluated-occurrence policy supports the proven metre-unit AC20 slab
case, retaining the unique product definition shape and cloning only its shared
Body wrapper. It preserves the canonical post-opening shape, material metadata,
GlobalId, placement, properties and semantic relationships. An opening's uniquely
owned Body becomes Reference in the same native plan; its original render mesh
travels as bounded companion geometry for preview, cancellation and Undo/Redo.
Hidden opening types remain nonresident during preparation, and Undo followed by
Show restores actual selectable geometry. Ambiguous ownership, aggregate sharing,
textured opening companions, sliceable material layers and unsupported units stay
explicit refusals. The default representation policy remains preserve.

The native before/after triangles and the independent reader with Reference
subtraction disabled have zero sampled bidirectional surface distance and exactly
equal volume. IfcOpenShell 0.8.2 with default settings incorrectly subtracts the
Reference opening again; this interoperability caveat is reproduced below rather
than described as a successful default-reader roundtrip.

The real shown single-model and hidden federated viewer journeys exercise
Preview/Compare/Apply/Undo/Redo, actual opening selection and IFCZIP export. The
federated run uncovered a separate immutable mesh-array cache defect; its fix and
recorded browser evidence are in [#4451](../federated-mesh-replacement/README.md).
Stable explicit face masks and query-scope acceptance remain separate pending F6
work; this conversion slice does not claim to complete all of #4404.

## Initial investigation and accepted invariants

Before this change, the evaluated-occurrence planner refused any selected product in the
canonical prepass `void_index`, including openings propagated through aggregates.
It then separately requires a uniquely owned mapped Body. The first restriction
cannot simply be removed: evaluated host triangles already include their holes,
while retaining subtractive opening Body representations asks readers to cut them
again. The earlier AC20 slab #59290 prototype therefore remained unshipped.

buildingSMART defines an opening's `RepresentationIdentifier = 'Body'` as a
subtractive shape. Its `Reference` representation accompanies an already-cut
host and must not be subtracted. See the [IFC opening semantics](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcOpeningElement.htm).
Before #4433 the native representation predicate prioritized `RepresentationType`
over the identifier, so a `Reference` representation of type `SweptSolid` still
qualified for both ordinary element meshing and void probes. The shared element-aware predicate now excludes Reference representations only
for opening elements, including mixed Body/Reference and mapped Body cases.
Ordinary products retain their previous rendering convention.

The conversion policy is checked against these invariants:

- Reference-only openings do not cut a host; mixed Body/Reference openings cut
  only their Body geometry in every canonical void path.
- Converting a host preserves its already-cut oriented triangle corners. The
  opening entities, placements, GlobalIds, void/fill relationships and filling
  objects retain their identities. No second visible host Body is introduced.
- An opening whose subtractive semantics affect any unconverted aggregate child
  is refused until occurrence isolation can be proved. Shared PDS/representation
  wrappers and unsupported styles remain explicit refusals.
- The final image/page plan changes host geometry and opening representation
  semantics atomically. Undo restores both in the existing transaction.
- An independent reader reopens the actual exported plan; schema findings are
  compared with the same source baseline rather than assuming that source clean.

Face masks must bind to explicit product/item identity and a validated canonical
triangle snapshot. A geometry revision invalidates the mask rather than silently
reusing triangle ordinals. Query scopes resolve to a bounded explicit product set
before preview; they must not widen between preview and Apply.

The following historical checkpoints explain why the final policy requires both
canonical source preservation and explicit opening companion publication.

## Reproduced prerequisite

[Native observations](native-reference.json) record the same generated IFC on
base and branch: the already-cut slab changes from the incorrect 64 triangles
to 32. The [independent reader](independent-reader.json) reports 32 triangles and
equal source/reopened volume. Baseline schema findings are 170, and the generated
fixture has 169, with no new entity/rule findings. EXPRESS diagnostics embed
referenced rows; the checker compares entity ID plus rule and invariant expression
so a changed PDS string does not relabel an existing Box/type-map WR11 violation.

Reproduce using IfcOpenShell 0.8.2 and numpy:

```sh
python3 docs/architecture/evidence/evaluated-openings/reproduce-reference.py \
  tests/models/ara3d/AC20-FZK-Haus.ifc /tmp/reference-opening
cargo run -p ifc-lite-processing --example evaluated_policy_probe -- \
  /tmp/reference-opening/reference-opening.ifc 59290
cargo test -p ifc-lite-geometry reference_opening_tests --lib
```

The script creates the already-cut tessellation with the independent reader.
It is evidence for consuming Reference opening semantics, not an implementation
of native appearance authoring. It preserves the unique occurrence PDS, replaces
its shared Body reference with a new wrapper and retains the shared type graph.
The opening keeps its entity, placement and relationships; only its unique shape
identifier changes to Reference. Earlier whole-PDS cloning left an orphan PDS
and violated ShapeOfProduct, so that prototype is not an acceptable authoring policy.

Native f32 cut triangles can be retriangulated differently by an independent
reader. Later conversion acceptance must compare world surfaces and volume;
face-mask identity stays tied to the canonical native triangle snapshot.

[Fresh WASM reopening](wasm-reference.json) uses the canonical prepass/batch API and reports one slab
with 32 triangles and finite coordinates. Run `node docs/architecture/evidence/evaluated-openings/reopen-reference.mjs /tmp/reference-opening/reference-opening.ifc` after regenerating WASM.
[Controlled native performance](performance.json) compares exact source revisions
on AC20 and ISSUE_129; no material normal-load regression was resolved. These
numbers do not claim browser worker-pool performance.

## Authoring source evaluation checkpoint

The actual AC20 slab #59290 is not sliceable according to the canonical
MaterialLayerIndex. Its material relationship can remain untouched without
weakening the existing refusal for products requiring material-layer slicing.
The appearance evaluator previously passed an empty void map even when supplied
with resolved prepass metadata; a fixture regression produces the uncut slab
instead of the canonical 32-triangle result. Passing the resolved void map into
the existing element funnel restores exact oriented world-corner equality.
This checkpoint alone does not enable opening-bearing appearance authoring.

The supported first conversion must retain the unique occurrence PDS. Because
this slab's Body is also referenced by a type representation map, its replacement
needs a new Body wrapper and a PDS representation-list edit; mutating the old
Body would alter the shared type. Plain layer membership must follow the new
Body without changing its existing members. Opening representation edits require
unique opening/PDS ownership and a proof that no unconverted host or aggregate
child consumes that opening. Existing source identities, non-Body wrappers,
material associations and semantic relationships remain in place.

## Textured Reference host routing

Reference-only openings also leave the host on the canonical textured submesh
path. A retained void relationship alone must not select the untextured cutter
path. `GeometryRouter::opening_requires_subtraction` conservatively inspects the
opening's bounded representation list using the shared element-aware policy;
unknown or malformed data retains ordinary cutter/error handling. Mixed
Body/Reference openings still subtract their Body geometry. This loader behavior
does not itself enable post-opening appearance conversion.

[Reference host texture evidence](reference-textures.json) records the exact
source revisions, fresh native/WASM contracts, and controlled normal-load probes.
The [buildingSMART opening definition](https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcOpeningElement.htm)
specifies that Reference geometry accompanies an existing hole without another
subtraction. The native and WASM regressions use a closed textured cube, including
Reference plus BoundingBox, mixed Body/Reference, and malformed-list controls.

## Independent surface oracle and reader interoperability

`verify-native-opening.py` compares the canonical native source snapshot with
its authored IFC triangle surface and an independent IfcOpenShell 0.8.2 read.
It reconstructs serialized f32 positions as f32 before adding the f64 origin;
otherwise shortest f32-roundtrip JSON decimals introduce a false comparison error.
The native source and authored raw surface have equal oriented volume and zero
bidirectional sampled distance at vertices, edge midpoints and triangle centroids.
This is a sampled surface check, not a complete Hausdorff proof.

The original IfcOpenShell CSG surface differs slightly from the original native
CSG surface. That difference predates conversion and is reported separately.
IfcOpenShell 0.8.2 also subtracts Reference openings under its default settings;
`reproduce-reader-reference.py` isolates that behavior using uncut and already-cut
controls. An idempotent second cut can conceal the defect in a precut control.
The exported-surface oracle therefore reports both the default result and a read
with opening subtraction disabled, consistent with the retained Reference semantics.
The production authoring policy does not change IFC semantics to accommodate that
reader behavior.

## Final viewer and exported-file acceptance

[Viewer evidence](viewer-acceptance.json) records the shown single-model and hidden
federated journeys, runtime/source identity, exact restored geometry hashes and
actual viewport selection IDs. The final federated run also uses the merged
immutable-array cache fix. The exported models reopen textured and selectable;
model hide/show preserves them, and explicitly showing opening types does not
render the retained Reference opening.

The [single-model exported IFC](viewer-shown-reader.json) and
[federated exported IFC](viewer-federated-reader.json) each preserve the canonical
native surface and volume exactly under the reader setting honoring Reference
semantics. The verifier resolves the actual exported Body item rather than
assuming the viewer and native evidence allocator assigned the same new ID. It
uses the native plan only for its canonical source snapshot and expected edits to
existing rows; it does not claim that plan is the browser's exact wire request.
Schema findings remain baseline-relative, with no new findings.

[Normal-load profiling](authoring-performance.json) records the controlled
pre-integration source checkpoints and the small AC20 timing increase; no speedup
or browser-worker timing claim is made.
