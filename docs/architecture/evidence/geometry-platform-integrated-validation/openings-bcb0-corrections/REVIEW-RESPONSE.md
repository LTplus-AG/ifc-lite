<!-- SPDX-License-Identifier: MPL-2.0 -->
# Corrections to the frozen retained-opening source review

Correction source `bcb0e55784f240c0081e36ff8dd126ebe29ff2b7` follows unchanged
`e532016a15`, preserving frozen implementation `719a7e4b2a` and its original
assembly/qualification evidence. Seven source/test files change. No parent root,
runtime, native adapter, tolerance, numerical assertion, retained-walk or pending
reply Box/reservation source is overlaid. These are source corrections awaiting
fresh closure review, compilation and actual execution.

The independent frozen719 review inputs were read directly and pinned exactly:

- `/tmp/ifclite-openings719-review.md`: SHA256 `23439919d77da5490c84d6578d88c922055aec830e766fdae7e04f962da6986f`.
- `/tmp/ifclite-openings719-review.json`: SHA256 `75462648e01fdf6e6f6578fe9238887449e60fda0f89d6e7819617fd32d64b56`.

For the PlainParts finding, `retained_child` now computes
`values.iter().all(LogicalRetainedValue::is_empty)` before moving the vector,
matching both existing body-role branches. The common real-source witness uses
an empty Items list and requires empty output, true Empty metadata, zero cuts,
related0, no grouping deferral, discharged product OpeningClosure and unreached
opening source. Its nonempty control explicitly checks false Empty metadata.
The SDK-gated witness selects the original no-index VoidedParts attempt through
the shared processing ledger, executes the real source Boolean Difference-to-Empty
and checks the sealed final Empty fact plus the same closure/laziness metadata.
It supplies no successful numerical result or Empty classification itself.

For the unused diagnostic backing finding, the original classifier constructor
now shares `for_contract` policy. HostOpenings passes the selected retained flag
before construction. Retained diagnostic storage is `Vec::new()`; the exact
branch retains the same `Vec::with_capacity(ids.len())` expression and allocation
order. Late classifier mode selection is removed so it cannot allocate exact
backing and then switch contracts. Existing exact-only callers still use their
original constructor entry.

The bounded real-source witness supplies 2053 repeated opening occurrences and
prepares immutable source/index inputs before the zero-live-byte child domain.
It checks actual diagnostic Vec capacity, because account counters alone cannot
detect an unadmitted allocation. It then runs the original Decode/Body transitions
and reaches a typed LiveBytes refusal before genuinely required child ancestry
backing can grow. It checks zero admitted peak bytes, first-fault preservation,
terminal reporting and unreached cutter source. A positive exact-mode control
requires the original proportional capacity before any opening source poll.
These are allocation/control invariants over actual source, not source-text tests,
mock processors or fabricated runtime receipts.

`hashes.json` records correction-file before719/after SHA256 values and verifies
that every before719 blob equals its e532 parent blob. It also pins unchanged
retained-walk, pending protocol/Box-reservation, unary-clip and TypeMap sources.
`correction.patch.gz` is the seven-file correction only: its bytes equal the
719-relative diff restricted to those source paths. Apply it to e532.
`from719.patch.gz` is the complete 719-relative patch, including the unchanged
original e532 evidence additions. Each independently reconstructs the corrected
source's exact complete Git tree from its declared base, using a temporary private
Git index. The actual source worktree/index remains untouched by reconstruction.

Rust syntax-only parsing and whitespace checks passed. No tests, builds, Clippy,
SDK/Worker execution, numerics or performance ran; all remain **UNRUN**. No heavy
submission, PR, push or publication was made. Parent workspace501b/sourcea338 and
later qualify.sh verdict changes are separate source identities and qualify none
of this correction. Original scope and preservation/final-publication holds remain.
