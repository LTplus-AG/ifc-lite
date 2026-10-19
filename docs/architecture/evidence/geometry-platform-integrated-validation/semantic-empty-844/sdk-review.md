# Strict semantic empty SDK review

Read-only diagnosis following actual SDK job608af49c-4242-4f1b-956c-296811e67788 source5f39: parent reports build/link passed, four of five CTests passed and the owned-boundary empty invariant failed. The separately reported reused-worker opcode19 counterexamples are supplied execution evidence; this reviewer ran no executable. Pinned SDK inspected: /tmp/ifclite-public-sdk-c9c5979/usd-brep, c9c5979f04cea8c38213004d4f04df0dcfb40d05, tracked status clean. No SDK/adapter edits, builds or jobs.

## Definite API misuse

SmBrep.cpp11503–11509 implements IsEmptyModel by testing that infinite-region and all three auxiliary topology-list HEAD pointers are null. The ordinary constructor (roughly531–550) allocates an infinite region, marks it void TRUE, inserts it in the BRep owning region list and allocates the face/edge/vertex list headers even when the lists contain no geometry. Therefore the raw method is a cleared/uninitialized-container predicate, not a sufficient semantic empty-solid query. This explains why a valid empty Boolean can retain a void infinite region and answer false. No volume/meshing oracle is needed to establish this defect.

GetInfiniteRegion returns the actual pointer. GetRegions at38240 delegates owning GetAll with null filters. SmOwningTopology.h390–459 walks the full circular owned list, includes the inserted head/infinite region, and bounds unfiltered traversal by its recorded list size. GetFaces, GetEdges, GetVertices enumerate the contents of their separate list headers. Region.h119 returns m_bIsVoidFlag directly: TRUE means absent material; non-manifold region voidness is explicit, not inferred from orientation. SmTypes.h45/232–240 defines SmBoolean=int, TRUE=1, FALSE=0, UNSURE=2. Truthiness would wrongly certify UNSURE.

## Recommended shared sufficient certificate

Implement one internal helper used by opcode19 and the zero-face tessellation admission:

1. If brep.IsEmptyModel()==TRUE, return certified empty immediately. Do this before GetFaces/GetEdges/GetVertices, whose implementations dereference list headers; cleared raw containers may have null headers.
2. Otherwise require non-null actual infinite region with IsVoid()==TRUE.
3. Require no enumerated faces, edges or vertices. Reject surface, wire and isolated-vertex models even if all regions are void.
4. Enumerate GetRegions without filters. Require a nonempty list, actual infinite pointer membership, and every entry non-null with IsVoid()==TRUE. Optionally additionally require every region's GetBrep()==&brep to reject foreign topology.
5. A still narrower safe certificate may reject any shells too. Empty shell remnants need explicit SDK qualification before accepting them; do not manufacture semantics from zero topology counts alone.

All failures return not-certified-empty, never guessed empty. In particular FALSE or UNSURE infinite-region flags reject unbounded material/uncertainty even when there are no faces, edges or vertices. Any additional material/uncertain region rejects, even if the infinite region is void. This is an explicit strict topology/material certificate, not a full SDK model validity proof. Query false must not be documented as proof of valid finite tessellatable material.

The same certificate must govern mesh.cpp16; merely fixing adapter.cpp236 leaves semantic empty Booleans rejected by the current no-tessellatable-faces guard. Keep nonempty no-face and partial-tessellation refusals. The C header currently names raw IsEmptyModel as semantic authority and must describe the new certificate rather than retain the incorrect statement.

## Required real SDK positive and negative witnesses

Keep the current actual box-disjoint Intersection and A-A Difference, empty/empty and both-order empty/nonempty Boolean identities, source survival, topology-empty mesh, release/stale handle and null argument checks. Do not weaken these or replace them with a zero-volume check.

Add direct actual SDK helper tests using an ordinary context-allocated SmBrep: a fresh default BRep has an actual void infinite region and should certify empty despite raw IsEmptyModel false. On the same real topology, SetIsVoid(FALSE) must reject a full-space material domain; SetIsVoid(UNSURE) must reject uncertainty; restore TRUE and recover positive certification. Add a real MakeShellVertex point and real wire/surface fixtures to reject zero-face-but-present-geometry, and optionally an additional owned region flagged material/UNSURE through a legitimate SDK topology constructor. Do not manually corrupt a foreign linked-list pointer as a purported supported model. The all-regions condition can be source-reviewed if a supported additional-region fixture is impractical, but record that test gap.

These strict negatives expose the dangerous classifier noFaces && noEdges && noVertices without IsVoid semantics, and also expose a truthiness implementation. They are SDK numerical/topology witnesses only after actually executed under admission. Current source diagnosis is not a passing-runtime claim; surface-count and other historical qualification obligations remain separate.

Exact inspected hashes and clean SDK pin: /tmp/ifclite-semantic-empty-sdk-hashes.json.
