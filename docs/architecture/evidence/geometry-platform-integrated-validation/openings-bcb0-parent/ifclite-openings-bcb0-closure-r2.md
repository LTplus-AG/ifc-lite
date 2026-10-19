<!-- SPDX-License-Identifier: MPL-2.0 -->
# Opening correction closure review, round 2

Read-only review of immutable source `bcb0e55784f240c0081e36ff8dd126ebe29ff2b7` against `719a7e4b2ad6ba8376c369a5fb6467950e66df21`, original feature base `68da7b8a96`. This is a fresh review; the interrupted earlier hash manifest is not treated as a completed verdict. Seven changed Rust paths and relevant original void/classifier/child admission/processing test seams were inspected. No edits, builds, test execution, SDK/browser numerics or heavy jobs were performed.

## Verdict

Both prior P2 findings are closed in source. No new blocker was identified in this seven-path correction scope. This is not compilation or runtime qualification and does not close the wider retained-opening compatibility, final-product or migration requirements.

## PlainParts Empty fact

`inner_voids_retained.rs:93-97` now computes `values.iter().all(LogicalRetainedValue::is_empty)` before consuming values, exactly as the existing BodyParts/BodyStyled branch does. Thus both actual semantic Empty values and an empty authentic source list produce the correct no-related completion fact. The branch still sets related=0 and does not start opening context admission. It does not derive Empty from mesh bounds or synthesize a numerical outcome.

The new source/control witness in `inner_voids_source_tests.rs:156` removes the representation Items from the existing real source, traverses the original request/admit/accept controls, requires zero operations, and checks empty plan, correct terminal completion, retained appearance hold and unreached opening entities. Its nonempty control now explicitly asserts false. The SDK-gated `opening_tests.rs:256` witness uses the existing real A-A empty-host source, an absent effective void index, and actual issued work executed by the worker before original acceptance; it checks exactly one sealed Empty Boolean, terminal Empty fact and no cutter/context reads. Setting the internal stage selects the existing VoidedParts entry in this unit fixture; it is not a fabricated receipt or a public end-to-end product API test. Execution remains pending.

## Classifier backing admission

`classify.rs:54-75` selects the immutable contract at construction. Retained mode uses Vec::new for the unused diagnostic backing. Exact mode still allocates with_capacity(ids.len()) in the original field order. `openings/mod.rs:68-70` now passes its already-selected retained flag through `classifier_for_contract` before constructor allocation. The late classifier selection arm/method is removed; Host selection remains valid before its later classifier construction. Exact direct classifier callers continue through from_owned(...false).

The repeated-opening witness in `classify_allocation_tests.rs:15-45` is more than a constructor readback: it checks actual backing capacity (account counters alone miss unadmitted allocations), advances the existing classifier Decode and Body child from the real source, attempts actual retained child admission under zero live-byte headroom with an active captured walk, and requires typed LiveBytes refusal, sticky first fault, no peak backing, completion with the same stop and no cutter-source read. Its prebuilt selected ids and prewarmed opening entity are outside the bounded child account by explicit design; it does not claim to prove their own admission or all SDK heap. The exact positive control preserves eager diagnostic allocation before source polling. The tests would statically catch the previous eager retained backing, but their behavioral execution is still unverified.

## Preserved scope and residuals

The correction does not change numerical math, ordered cuts, frames, sealed receipt validation, original pending reply/linear acceptance, default exact policy or runtime/native modules. It adds no alternate walker/executor. Only corresponding terminal OpeningClosure is discharged. Eligible layers, custom source processors, optimized grouping diagnostics/callback policy, persistent faces, appearance, mixed-controller bounds, final output and full consumer/platform/performance qualification remain explicit residuals. Prior719 source review remains the broader feature review; this verdict concerns these repairs and their called seams, not a new full feature re-audit.

Fleet metadata was inspected: Pop refused78; PC allowed at that instant. No capacity claim is made beyond that observation and no validation was submitted.
