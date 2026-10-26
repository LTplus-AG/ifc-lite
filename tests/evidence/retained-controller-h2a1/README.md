<!-- SPDX-License-Identifier: MPL-2.0 -->

# Retained construction controller mutation inputs (#7955)

These patches are inputs, not observed validation results. Apply each with
`git apply --reverse`, run the selected tests through the parent's admitted
validation job, then restore it with `git apply`. Run each independent mutation
against the clean candidate; never stack mutations when attributing a result.
The mutated tests must compile and fail a behavioral assertion. A build failure,
skip or timeout is not an observed oracle.

The controller test prefix is
`program::inner::retained_program::tests`. The synthetic inline IFC fixtures
exercise the actual decoder, retained capture/lowering and controller. They are
regression inputs, not real-authoring-tool or runtime qualification evidence.

The pre-review mutations remain independent:

- `source-identity.oracle.patch`: recorded STEP id is changed to zero; repeated
  extrusion and disk source-id assertions fail. This does not authenticate the
  root, epoch/revision labels or source coherence.
- `disk-root.oracle.patch`: disk recipe root is changed to zero; the positive
  reached disk admission/count assertion fails after the real lowerer refuses.
- `exact-nonconsumption.oracle.patch`: outer retained readiness refusal is
  disabled while the inner refusal remains. Explicit pending/unexecuted and
  retained-ready assertions observe consumption before subsequent admission.
- `obligations.oracle.patch`: opening and layer obligations are removed;
  `obligations::relationship_host_keeps_all_unchecked_obligations` fails for
  actual relationship-bearing source as well as the plain product.

The S1 review corrections add independent mutations:

- `structural-members.oracle.patch`: raw list-member rejection is disabled.
  `structure::malformed_later_items_refuse_whole_retained_plan_and_preserve_exact`
  and `structure::malformed_later_representations_refuse_whole_retained_plan_and_preserve_exact`
  must fail their whole-plan refusal assertions. Both use a supported first
  member followed by `$`, `*`, numeric, string, nested or typed values.
- `representation-type.oracle.patch`: the referenced shape-representation
  type check is disabled. The wrong-record regression must fail when the
  shared selector would otherwise drop the malformed later record.
- `product-root.oracle.patch`: the `IfcProduct` category check is disabled.
  The real `IfcMaterialLayer` root regression must fail its refusal assertion;
  paired real-product/no-Representation cases must remain successful and empty.
- `composed-frame.oracle.patch`: the composed-result finiteness check is
  disabled. The reached extrusion-plus-product `1e308 + 1e308` regression
  must fail whole-plan refusal. Separate tests exercise world-source overflow
  and initial unit composition with finite source/inverse inputs. The ordinary
  translated/rotated extrusion remains a positive control.
- `placement-atomicity.oracle.patch`: slot mutation is moved ahead of checked
  composition while the finite-frame guard remains active. The two frame
  failure-invariant tests must fail equality with the last valid value. Valid
  placements keep the same behavior; this isolates refusal-side state changes.

The skipped-reference P2 correction adds two independent mutations, retaining
all ten earlier mutation mechanisms:

- `item-resolution.oracle.patch`: a shallow item decode failure is ignored,
  keeping category rejection for successfully decoded items. Run the new
  `structure::references::skipped_axis_later_dangling_reference_refuses_whole_plan`
  witness (and its topology and duplicate-mapped counterparts). Its valid
  Body-plus-Axis control must succeed with one reached Body operation; the
  later `#999` must fail the whole-plan refusal assertion only under mutation.
- `item-category.oracle.patch`: only the generated `IfcRepresentationItem`
  subtype guard is disabled; shallow decoding remains required. The new
  `structure::references::skipped_axis_later_wrong_item_category_refuses_whole_plan`
  witness must fail its whole-plan refusal assertion for the later `#1`
  (`IfcProject`) after valid `#53`. Topology and duplicate-mapped counterparts
  also cover existing profile/map records and an unknown keyword. Selected Body
  regressions and selected unsupported-family controls remain in the suite.

`behaviour.oracle.patch` combines the original nine independent mutations and
is selected by the existing CI workflow. Context has been refreshed for the
contained S1 implementation; its original nine mechanisms remain the same.
Run the two P2 mutations and all late-review mutations separately. A red combined run proves at least one
assertion detected a regression; it does not establish independent observation
of every mechanism. Require candidate baseline green, each independent mutant
compiling and assertion-red, then restored candidate green with the same tests
and tolerances. A blocked/NEVER RAN job is not qualification.

Runtime red/green execution, strict workspace Clippy, workspace and wasm gates,
base/branch performance and fresh independent review are **UNRUN by this
implementation child** and remain with the parent. The patch inputs and test
discovery can be checked without a heavy reservation. No release, execution
authority or #7955 completion is claimed.

## Late independent review corrections (F1–F12)

The construction facade is crate-private until its first cross-crate consumer
S4a. See [the internal contract](internal-contract.md) for scope and debts; the
published Rust API guide no longer advertises this unconsumed surface. Existing
published APIs are unchanged. The removed operation-output placeholder test
only manufactured a variant no S1 production path could construct. All 37
baseline controller tests remain, with accessor/copy adaptations and stronger
explicit exact-nonconsumption assertions.

Eight additional standalone mutation inputs isolate the late review fixes:

- `admission-stop-report`: turns a real try_copy resource stop into Unsupported.
  `admission::admission_budget_stop_preserves_original_stop_ticket_and_reached_operation`
  must fail typed equality for work budgets 1/2 while the operation stays ready.
- `admission-header-stop-report`: misreports the output header reservation stop.
  The same test's zero-work case must fail typed equality.
- `admission-copy-budget`: removes only the logical-copy reserve/charge work
  checks. The same test's work=1 case must fail refusal; this tests the bound
  independently from stop reporting. The zero-work output-header case survives.
- `placement-rigidity`: bypasses only proper-rigid checking. The reached scale
  and reflection test must fail refusal; identity placement remains positive.
- `placement-singularity`: bypasses both overlapping placement checks. The
  reached singular-matrix test must fail refusal. Removing only validate_affine
  leaves proper_rigid's determinant check, so no independent singular witness
  for that redundant check alone is claimed.
- `item-exact-guard`: removes only the item-level exact guard. A real captured
  item is driven directly, independently of the outer product guard, and the
  immediate UnsupportedRetained assertion must fail.
- `refused-owner-binding`: restores binding before the outer refusal. A real
  reached controller in a fresh protocol wrapper must fail its unbound-owner
  assertions. Normal traversal already has bound owners; this is a boundary
  invariant, not a claim that normal traversal loses its owners.
- `source-reply-postcheck`: restores the fallible check after source execution.
  The zero-budget source-capture stop must fail the reply-return assertion.
  The control requires the original stop in the actual reply and repeated
  rejection returning that reply intact.

`admission::default_step_errors_keep_the_one_byte_protocol_contract` asserts
only the explicit ProgramError/Result layout contract from F3. It does not
measure performance or pin platform-dependent controller sizes. A separate
WASM-only test specifies Unsupported for absent capture capability; no WASM
execution is claimed here.

The retained shape wrapper is named `validated_product_shape` to distinguish
it from `representation::product_shape`. The latter reads one definition and
its finite authored representation list; the wrapper shallowly checks finite
Items lists, never their children. The old same-name call was a lexical
self-recursion false positive in refwalk discovery. No guard, allowlist, or
budget threshold was relaxed. This does not claim full resource accounting
for authored list sizes.

Fresh review precedes parent gates. All new tests and all 20 mutation executions
are UNRUN by this child. Historical review results do not qualify this candidate.
The combined CI mutation still proves only that at least one included mechanism
was observed; parent qualification must run each standalone patch independently.
PERF/ID/DET, full workspace tests/Clippy and WASM checks remain parent gates.
