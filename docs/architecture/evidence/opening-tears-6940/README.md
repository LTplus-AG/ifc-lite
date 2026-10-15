# Opening-tear repair evidence (#6940)

Authentic model captures, unedited T3 screenshots, replay harnesses and
independently reviewed evidence for the five-layer repair. No model fixture
or generated geometry runtime is committed here.

- [MiniBIM native/WASM/browser proof](minibim/README.md): all 27 canonical
  none/one/all contexts match native bytes, all 18 established shape checks
  pass, and all nine actual viewer target slabs match WASM.
- [RVT13797 explained output change](rvt13797/README.md): complete finite-face
  and exact layer-aware projected multiplicity accounting, including worsened
  aggregate edge counts and both independent bounded reviews.

Functional execution is at `1cb4bd2119e36261322227249b2f89bc03194f04`, paired
with selected main `d03448ac4b0a64722446288d0e2bfd798cfda947`. Expected data at
`58a01227c7ccf20cc0ac701a6afd5a70e40e7848` changes only three of 1,640 census
rows; production files remain unchanged. Original execution identities are
retained, not relabeled as this evidence-documentation commit.

Minimal native ModelFrame/census output and canonical prepass/FFI output are
separate contexts: slab135923's all-opening results have 892 and 1,608 triangles
respectively; both pass closure and shape checks. Eight lower-layer Watertight
source controls do not imply all raw IndexOnly sources were closed. The complete
model retains two CSG failures elsewhere.

Archives preserve receipts and analysis code for auditing. Manifests bind every
member and screenshot copy to original bytes. Obtain authentic fixtures through
the fixture catalog; replay requires fresh paths/builds/receipts and does not
recreate the original executable hash. Read each packet's limits before replay.

This demonstrates the stated functional behavior and explained census changes.
It does not establish full-model correctness, exact 3D identity, GPU-buffer/pixel
identity, universal material equivalence or performance. Original failed
ordinary/native runs remain recorded. Fresh pushed-head CI, review and
worker-pool performance are separate requirements.
