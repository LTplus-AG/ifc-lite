# Opening unwind regression delivery

Uncommitted test-only change above root `0446a34f13`:

- `rust/geometry/src/program/openings/unwind_tests.rs`: one isolated real-kernel unwind regression and small fixture/budget helpers.
- `rust/geometry/src/program/openings/execute.rs`: only a cfg(test) sibling module declaration (four lines).

Exact hashes are in `/tmp/ifclite-opening-unwind-regression-hashes.json`. No production algorithms, existing tests, ratchets or other files were edited.

## Implemented invariant

`opening_root_unwind_drains_real_capped_failure_and_preserves_payload_once` constructs the existing closed off-grid flanking-box geometry, performs actual `ClippingProcessor::subtract_mesh` with exact predicate element cap 1, and requires both real rejection and one real buffered failure **before** triggering unwind. The actual production `FailureCapture` drains during unwinding before the ordinary finalizer is called. The test catches at the same lexical boundary used by production, consumes the resulting owned `NumericalOutcome` through its actual `publish`, and catches the resumed panic outside publication. An Arc payload identity assertion proves no panic substitution.

Behavioral checks require exactly one attributed OperandTooLarge record, exactly one host failure summary, no false consumed/cut output, an empty processor log after unwind, empty router logs after the first diagnostic drain, and one actual CSG census entry (no retry). No fabricated BoolFailure, mock numerical executor or source-text assertion is used. A dedicated subprocess isolates process-global census/budget state. A lexical restore guard restores global cap settings on normal exit and unwinding.

## Staged-child invariant not implemented

I did not add a manual provisional Execution/drop test and label it an actual staged-path regression. The actual `try_staged_bool2d` path owns its child locally. The existing configurable correction gate can trigger an unwind after residual execution, but the existing mixed geometry does not establish a positive capped-failure witness in that child. The new test module can access the parent Execution internals, but the real precursor/evaluation helper `try_bool2d_cut` and the existing mixed fixture are restricted to the router voids module. A manually manufactured child or a budget-trip-only assertion would not prove the requested child failure evidence existed.

The next faithful witness should be placed with the actual router staged tests (or widen test-only access to their real precursor helper): generate the actual mixed precursor, independently run that exact residual mesh/cutter combination and require a real OperandTooLarge failure, reset the budget/census, then drive the actual staged path with the correction gate unwinding after residual completion. Require no parent failure/route telemetry, original panic, and retained actual census. A terminal correction variant can use the existing stop gate. This needs careful positive geometry qualification; no production fault hook was introduced here and this remaining case is not claimed covered.

## Checks and limitations

Pinned rustfmt parse-only (`--emit stdout --config skip_children=true`) succeeded for the new test and cfg-wiring file; outputs are `/tmp/ifclite-opening-root-unwind-syntax.rs` and `/tmp/ifclite-opening-execute-unwind-syntax.rs`. `git diff --check` passed for the two paths. These establish syntax/whitespace only, not Rust type correctness or executed geometry behavior. No Cargo, heavy test, build or profiling job was started. Fleet status reported Pop admission false/78, PC reachable (drain unresolved under parent instructions), Mac disabled. No new job was submitted.
