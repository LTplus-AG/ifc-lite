# Independent R1 P2 response

Review reference: delegated-task:command%3Amcp%3A55805d56-4cbd-47f7-89c1-076c896c961c%3Adelegate-task%3Aactual-account-8af499-boundary-review-20261019-r1.

The finding is accepted. Before binding, the old account error adapter stopped the fresh authority with Cancelled before self.record could select the retained original-source fault F. Returning F could not repair that fresh epoch's first fault.

The narrow repair checks the retained original stop before operation entry and calls self.record before authority.stop for account, observer, and binding-admission errors. Thus retained-source/account/observer precedence is resolved before committing the fresh epoch. The original account still keeps its independent first fault.

One regression creates a healthy gate and ends its work. It independently establishes original-source F and, in one arm, account Cancelled, then reenters fresh work on the same decoder, lease and account. Both arms require no operation entry, returned F, observer F, original-source F and fresh-source F. The cancelled arm additionally requires the account to remain Cancelled; the healthy arm requires the selected F. Container storage/admission/refund counters remain unchanged; dropping gate/observer metadata and cleanup must succeed. The account is the existing Budget fixture, explicitly not the actual geometry account.

Only gate.rs and observer_tests.rs changed. No parser/owner/cache activation or broader normal-identity test seam was implemented. The adjacent proposal is for parent coordination before any additional broad edits.

Compilation, tests, lint, wasm, packaging, default preservation, performance and mutation execution are UNRUN. Prior source evidence is not relabeled. No build/job/GitHub action/root overlay occurred. Frozen R2/R3/R4/P2/8af delivery manifests remain unchanged and were integrity-checked.
