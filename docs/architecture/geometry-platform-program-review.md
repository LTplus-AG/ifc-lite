<!-- SPDX-License-Identifier: MPL-2.0 -->
# Product-program preservation review

This checklist records concrete review obligations found in the corrected
mapping/model-context source. It supplements the
[program design](geometry-platform-product-program.md); it does not certify
implementation or broaden the scope of existing receipts.

One shared representation/item program needs five explicit entry policies:
merged product, styled product, type map, opening item meshes and opening item
bounds. Sharing control does not make their source-admission rules identical.

| Existing boundary | Behavior the replacement must demonstrate |
| --- | --- |
| Product representation selection | Resolve the complete representation list before selection; resolve each selected whole item list before executing its first item. A bad later reference must preserve the original failure timing. |
| Merged mapping | Resolve transform before cache lookup; on a miss, admit required Items before the source-loss claim. Failed mapped children mark enclosing sources truncated and unwind path membership. |
| Styled mapping | Resolve representation before transform; claim before optional Items. Failed admitted mappings retain the existing sticky path behavior. Transform only the actual appended output range. |
| Type-map items | Keep textured items separate and untextured parts grouped by frame. Nested mappings retain their current merged-consumer behavior. Non-Body maps still walk with counting suppressed. |
| Type-map origin | Admit MappingOrigin after all items. A resolved value of another placement type contributes no transform; a reference-resolution failure still propagates at this late point. Ordinary mapped occurrences use stricter earlier validation. |
| Opening mesh probe | Resolve representations, then element placement, then per-representation Items. Placement failures use identity. Missing/bad item lists and failed individual items are skipped. Try the raw-per-element path before ordinary item parts. |
| Opening bounds probe | Preserve the same list/placement order and leniency. Read direction before geometry; use ordinary item parts rather than the mesh probe's raw-per-element route. Preserve one bounds result per actual frame part. |
| Built-in construction | Select the actual configured processor before admitting its owned constructor; family labels alone cannot authenticate dispatch. |
| Annotation fill | Own admitted rings/style data before numerical triangulation. This source/numeric seam is additional to the registered constructor families. |
| Texture construction | Use the existing owned triangulated payload and its texture evaluator; preserve texture-failure recovery into plain geometry. |

The opening distinctions are observable in
[`voids/probe.rs`](../../rust/geometry/src/router/voids/probe.rs:463).
The late type origin is observable in
[`textured.rs`](../../rust/geometry/src/router/textured.rs:84).
They require behavior tests with malformed siblings, alternate placement types,
source failures and positive surviving geometry; a text search is not proof.

The first implementation review also needs repeated DAG occurrences, cache-hit
read timing, inner counting under non-Body suppression, nested textured maps,
multi-frame cutters and actual custom/nested/scoped-worker callbacks. Preserve
the existing outer attempt/reply/drain protocol while replacing the inner
walks. Public router APIs must drive this same program, with replaced loops
deleted.

After replacing walks, run the positional-read, function-length, module-size and
styling-parity integration targets together before freezing source for the full
workspace run. Removed literal reads require allowance deletion as well as
removed functions; the mapping migration exposed both independently.

Layer eligibility/slicing and opening classification/capture orchestration
remain subsequent owned-control work if their geometry calls alone migrate.
Likewise, a synchronous inner driver is not proof of external reply execution,
complete effect envelopes, authenticated source/index bundles or terminal
resource refusal. Each requires its own implementation and evidence before
whole-platform cutover.
