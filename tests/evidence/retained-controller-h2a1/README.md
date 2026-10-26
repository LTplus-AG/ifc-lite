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
  disabled while the inner refusal remains; the same ticket's subsequent
  retained admission fails, observing consumption rather than just an error.
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
all ten earlier patch inputs unchanged:

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
is selected by the existing CI workflow. It intentionally remains unchanged;
run the two P2 mutations separately. A red combined run proves at least one
assertion detected a regression; it does not establish independent observation
of every mechanism. Require candidate baseline green, each independent mutant
compiling and assertion-red, then restored candidate green with the same tests
and tolerances. A blocked/NEVER RAN job is not qualification.

Runtime red/green execution, strict workspace Clippy, workspace and wasm gates,
base/branch performance and fresh independent review are **UNRUN by this
implementation child** and remain with the parent. The patch inputs and test
discovery can be checked without a heavy reservation. No release, execution
authority or #7955 completion is claimed.
