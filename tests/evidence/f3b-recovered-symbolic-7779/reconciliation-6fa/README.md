# Symbolic projection after placement-stack reconciliation

PR #7906 merged into the updated placement stack, and PR #7914 was retargeted
to `sweep/f3b-r2a`. The local reconciliation merges that branch at
`4bcaed8303135cdae3dad7459dd481af2cc2bbaa` and retains both conflicting
performance-ledger records. It preserves the symbolic error-classification
helper and all newer upstream placement changes. Five positional-read ratchet
entries were lowered to the actual symbolic counts, including deletion of the
zero-count entry. No production logic was changed in the symbolic module.

[Native qualification](native-qualification.json) binds exact source
`6fa1915e9fc88c9b78c89bc6079095a92fc2bdff`: all 182 fixtures fetched, strict
workspace/all-target Clippy passed, then the full workspace test run passed
6,103 tests with zero failures and 46 declared ignored. The worker confirms
clean, unchanged source before and after. The log hash and superseded failures
are retained in the summary; no test result from a failed attempt is counted
as qualification of this source.

The first local request was cancelled before admission to preserve existing
worker jobs and route this check to the available PC. An initial compile caught
the still-used classification helper being removed during reconciliation; it
was restored. The following run caught the stale ratchet entries; those were
lowered. Both failures preceded the successful source above, and neither
candidate was pushed before correction.

The [earlier packet](../takeover-42fa/README.md) remains evidence for its original
source. Its browser, WASM, TypeScript and paired performance results do not
qualify the newly combined dependencies. The earlier obsolete TypeScript
depth-cap assertion is now corrected in the inherited viewer source, but this
native run does not establish a passing current TypeScript graph. Current-source
consumer checks, performance acceptance and required hosted checks still block
merging. No benchmark ceiling, golden pin or acceptance threshold was changed
by this reconciliation.
