<!-- SPDX-License-Identifier: MPL-2.0 -->
# Browser retained boundary review

Inspected integration source: `e98406f5df`, 2026-10-19. This is a source
review, not browser compilation or execution evidence.

## Findings and disposition

1. `rust/geometry-runtime/src/browser_bridge.rs`: construction arms `InFlight`
   before JavaScript validates known caller limits. Rejection can retire a live
   independent worker and its prior receipts without submitting numerical work.
   Source repair assembled: validate finite positive chord, angle in `(0,180]`, and
   nonzero byte limit before the guard, consistently for construction and
   dependencies. An actual-Worker regression preserves an earlier receipt
   through invalid requests, then executes another construction; it also covers
   the accepted 180-degree boundary. The added tests remain unexecuted.
2. `rust/geometry-runtime/js/retained-driver.mjs`, `#readMesh`: all zero-count
   outputs are rejected. Disjoint intersection and complete subtraction can
   legitimately be empty. P2 must carry a sealed empty numerical result through
   the original common continuation and empty-host decisions. Permitting an
   arbitrary malformed empty mesh is not a repair. Both native and browser
   operation/result contracts require this audit.
3. `browser_bridge_tests.rs`: the construction cancellation witness observes
   session-open dispatch; the dependency witness observes operand-copy dispatch.
   These are real Worker requests, but do not prove cancellation during upload
   commit or Boolean allocation. The follow-up source repair now observes real
   detached frames by opcode, including staged uploads, and waits for commit 15
   or Boolean 5 before abandoning the Rust future. It proves submission before
   acceptance, not when SDK computation starts internally. Browser execution
   remains pending; the source repair alone does not qualify those cases.

The existing source-only browser publication remains distinct from a complete
product. It does not discharge common `ProgramRequest`/product owner/stage and
pending-transaction acceptance. P3 must bind those identities, ordered operands,
frames and captured source/resource authority before linear consumption, and
prove no lexical owner/TLS state survives an await.

Actual browser product execution, empty results, critical-operation cancellation,
timeout/lost-response handling, replacement isolation, operand release and final
publication after all coverage obligations remain unqualified. Existing Node
boundary tests and native SDK CTests do not substitute for these witnesses.
