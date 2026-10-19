# Large error representation correction

Shared-root changes are limited to the four files in the adjacent hash receipt, uncommitted and unstaged by this agent.

BooleanProgram.accept_source and accept_numerical now return a boxed original reply on protocol rejection only. Both validation predicates run before mutation as before; only the rejecting branch allocates. Successful source/numerical acceptance, effects, cancellation and report ownership are unchanged. The existing foreign-program, wrong-sequence and wrong-kind tests move the exact original packet out of the rejection Box before correcting/resubmitting it; their geometry and once-only diagnostic assertions are untouched. All other accept call sites discard impossible rejection payloads or check is_err and require no signature adaptation.

Prelude classification now returns PreludeWork::{Numerical(PreludeReadyWork),Source(PreludeAction)} via into_work. It is a classification, not a failure. Both callers preserve the same routing: ProductRootAdapter.take_ready extracts numerical work or restores the exact source action, and PreludeAction.execute executes numerical work or admits that same source action. No extra allocation, router/decoder payload, callbacks, early source reads or ordering changes were introduced.

Targeted rustfmt --emit stdout --config skip_children=true parsed the four files successfully without rewriting them. git diff --check passed. No heavy commands, builds, tests, Clippy, job submission, index changes or commits occurred. The original strict-Clippy reports supplied by the parent motivated these representations; this source correction remains runtime/Clippy-unqualified until the next admitted run.
