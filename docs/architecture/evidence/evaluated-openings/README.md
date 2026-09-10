# Opening conversion investigation (#4404)

The Reference-subtraction prerequisite is #4433. Appearance conversion remains
disabled; the broader #4404 policy below is pending.

The merged evaluated-occurrence planner refuses any selected product in the
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

The next slice must establish these invariants before enabling appearance:

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

Native and independent-reader measurements, fixtures and the final supported
policy will be recorded here as those checks complete.

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
