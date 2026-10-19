# Sealed replacement placement review

Reviewed immutable commit `6eed210aacaed4f9927b076072faa20a579ca82f`, parent `db58b8d10f35fb46b71f0c9ff5e76e3fdc4c65e1`. Companion `ifclite-placed-result-6eed-review-hashes.json` contains exact inspected Git blob/SHA256 identities. `git diff 6eed^ 6eed --check` passed. No edits, compilation, SDK execution, browser run or jobs. Reported rustfmt history is not compilation evidence.

## Verdict

No concrete source blocker found in the additive runtime seam. Native and browser implement an explicit replacement **evaluation-local metres to world metres** frame, not a relative placement or source-file-unit transform. The original Result branch is unchanged. Opcode18, rational conversion and logical bake behavior are unchanged. This does not yet repair the whole-control rigid-derived path: the common selector and geometry bake must be integrated and qualified separately.

## Replacement-frame proof

Native `worker_dependencies.rs:88–94` returns exactly `(result.solid, supplied_frame, Placed(original_lineage, supplied_frame), result.operations)`. There is no multiplication by the result's previous world frame or by a source/evaluation transform. Browser `browser_dependencies.rs:120–128` does the same with the original owner/object/handle. It then uses the existing shared proper-rigid check. The frame denotes the sealed result's actual object/evaluation coordinate basis, including its already evaluated geometry; it is not `world_from_source`. API docs could explicitly say evaluation-local metres on the browser variant too, to prevent this distinction being lost at the selector.

Existing Boolean evaluation uses the left supplied frame as the result frame and transforms only the copied right operand by `inverse(left_frame) * right_frame`. Native computes this f64 relative frame before sending the copy-transform; browser passes the equivalent frame to its existing driver. The replacement avoids putting the survey translation in SDK coordinates. It must not be implemented later by composing `old_world * supplied` or `supplied * old_world`, which would reintroduce the original survey frame.

The new SDK witness has a valid distinguishable oracle. The source is a 2×4×3 rectangle at profile position (1,2); centered profile starts at (-1,-2), so `profile_position * anchor_translation` is identity, units are 1 and no solid placement is present. Thus `source_from_evaluation` is identity, and the base sealed Boolean's frame equals `original` as asserted. The replacement quarter-turn has translation (3e8,4e8,5e8), different from the old (1e9,2e9,3e9). Both final operands genuinely coincide in the same local basis. Correct union volume is 24. Either composition with the old frame would separate them and fail this volume oracle (or provoke a remote-coordinate failure); metadata-only assertions are not the sole check.

For robustness, this fixture should explicitly assert the source/evaluation transform is identity before the first Boolean. That makes the reason the right source and left placed result coincide visible and prevents an unrelated recipe-anchor change from making the fixture misleading. This is an additional behavioral assertion, not a production blocker.

## Identity, authority and lifetime

- Native validates the original result's managed object liveness before reading it, validates the supplied frame, and retains the original opaque handle and operation count. Existing worker-local object checks still reject foreign/stale objects before numerical calls. No caller can construct `RetainedDependencyResult` fields.
- Browser validates the result and object, clones the same owner/object/opaque handle, and uses the same borrowed result lifetime across async evaluation. Existing pointer-equality owner checks precede arming the in-flight cancellation guard. Invalid frame or foreign dependency rejection therefore does not retire an unrelated worker through this new branch.
- `Arc::clone` of the original lineage is stored under `RetainedLineage::Placed`; the original result's frame, mesh, identity and count are not changed. Occurrence placement does not add a Boolean operation to the 128-operation budget. The subsequent Boolean adds its normal operation and binds the effective frames in the sealed identity.
- The placed dependency borrows the sealed result; it does not mint a standalone liveness lease or permit use after dropping the result. The new output is independently managed by existing Boolean result construction. Dropping/releasing base inputs must not invalidate that output.
- These are runtime sealed numerical dependencies, not canonical model/source authorization. Processing still has to compare the supplied frame and exact original handle against its captured logical operation/request before accepting a reply. A caller-selected placement is permitted by this low-level API; it does not authenticate a product occurrence.

## Actual witness coverage and gaps

`retained_receipt.rs:275–317` executes actual SDK operations when configured, not a mock. It releases source A before placed-result use; rejects a nonorthogonal frame and infinity; checks both original operands remain live after rejection; checks immutable original frame, effective result frame, left sealed handle, Placed ancestry, real union volume/manifold; then drops base and releases source B and verifies the independently owned output remains usable. Missing SDK environment skips, which is not a pass for this behavior.

The test does not directly compare original mesh buffers/count before/after, check the original result's operation count, exercise a right-hand PlacedResult or empty Result, or execute a browser worker. The branches statically preserve these fields, but those properties are not all established by this witness. Add right/left placement, empty operands, stale/foreign-object rejection and actual browser equivalents in their existing target qualification lanes. A native box success also cannot qualify class-preserving placement of an accepted result with a surface rejected by the affine certificate.

## Required whole-control test when composed

Current common source still has the old limitation: `program/retained.rs::LogicalRetainedValue::bake` emits an Affine operation for any nonidentity Operation frame; `session_retained/value.rs::dependency` only accepts a Boolean value when its frame exactly matches the result and otherwise reports that explicit affine is required. The new variants alone are therefore not the completed fix.

Add a real authenticated source fixture through `RetainedProductExecution` with a mapped representation containing a Boolean result, then a nonidentity proper-rigid outer mapping (rotation plus a different survey translation), and a subsequent Boolean/common operation using that occurrence. Drive the original common issue/execute/accept sequence; preserve every pending outer/inner request and actual runtime receipt. Assert:

1. The logical graph retains the Boolean result slot and rigid occurrence metadata rather than issuing Affine/rational conversion solely for that rigid placement; no second traversal or implicit union of mapped parts.
2. The selected numerical dependency is the exact sealed Boolean result at the independently expected replacement evaluation frame; an old-frame or swapped-frame receipt is rejected intact before consumption and no partial final product is published.
3. A coincident matching source gives the independently known volume and f64 frame, repeated different rigid occurrences reuse the definition but retain distinct occurrence identity, and the original result remains usable.
4. A nonidentity source/evaluation frame and nonunit IFC scale are included in another case: compute the expected absolute evaluation-to-world frame from the authored source and occurrence, not by treating a source frame as an evaluation frame. Retained units stay metres and RTC/survey rebasing is applied exactly once.
5. Nonrigid/reflection maps still use the explicit affine route; identity opcode18 conversion remains available to the plane path. Captured original resource cancellation/stop, stale source/generation, wrong owner and drop-before-accept remain terminal with original packets preserved.

An actual native SDK witness and actual browser module-worker witness must each drive this common control test after their selectors are composed. No current test establishes source-face/UV/presentation fidelity or final-net product completion; those P4 obligations remain open.
