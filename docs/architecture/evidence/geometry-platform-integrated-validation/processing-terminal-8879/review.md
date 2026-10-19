# Processing terminal acceptance failure diagnosis

Read-only review of current root 5bde6195627b6c6c9dda5d63d17f87cf176447f8 and actual original workspace job 887916da-9ea2-4528-966a-8d90b4cca9e4. Actual processing library result: 731 passed, one failed, one ignored. The failure is the post-accept request assertion at session_terminal_tests.rs159; no runtime evidence beyond the logged run is inferred. No edits, builds, or job submission.

## Verdict: real acceptance-boundary bug

The fixture is a valid product-publication cancellation test. Both geometry callbacks produce actual extrusion geometry, first map has already presented real mesh, and the second authentic outstanding reply is cancelled immediately before acceptance. Existing request, non-GeometryStep acceptance and finish explicitly capture a caller's current terminal. Changing the fixture to stop only inside an account captured at construction would remove a previously required boundary contract.

The exact losing path does not require an OwnedResourceContext to explain it:

1. ExecutionAccount::new(Compatibility) owns no inner account. Its scope establishes terminal_scope but installs no CURRENT account (account.rs64 onward).
2. resource::stop(Cancelled) therefore persists in TERMINAL only, not in an account object.
3. ProductState::accept_admission authenticates the complete reply but deliberately excludes GeometryStep from capture_stop (session.rs194 onward).
4. ProductOwner::work installs a new authenticated source epoch via with_source_stop. That helper intentionally replaces TERMINAL with Some(None), restoring unrelated ambient state later. It must retain this scoped-worker isolation behavior.
5. Inner program acceptance thus sees no cancellation; the closure samples no terminal. Outer state never remembers it. with_source_stop later restores the caller terminal, but account.scope ends and drops that terminal. The next request runs as normal, exactly matching the observed failed assertion.

This is a caller-boundary observation omission, not evidence that source authority isolation is wrong. Do not globally change with_source_stop/OwnedResourceContext to inherit arbitrary worker terminal state.

## Minimal repair recommendation

After validate_reply succeeds and before owner.work installs its source scope, snapshot the reached entrance stop. A foreign/stale reply must still be returned intact before any terminal state or evidence changes.

For GeometryStep, carry that observed stop into the authenticated closure, together with any stop already attached by execute and any previously remembered product stop. An actual source/execution stop attached to the legitimate reply must not be overwritten by a later unrelated ambient stop. Reassert the selected stop using resource::stop *before* program.accept, allowing the current validated source chain to choose its authoritative existing first fault. Then accept the real inner reply so reached numerical/source reports are delivered under their original policy, cancel_with_reports to discard the remaining continuation, and capture the resolved terminal before the source epoch unwinds. Remember that terminal in ProductState, clear earlier mesh/hash/instance output using the existing remember_stop, and consume the outer protocol once.

Do not simply include GeometryStep in the existing capture_stop-and-early-return branch: it would drop the real pending reply before forwarding its numerical/source evidence. Do not reassert a carried stop only after program.accept: inner cache/merge/assembly side effects could occur after a stop was already known. Completed independent cache/source effects from earlier work must remain intact.

The non-GeometryStep path can keep its existing early discard semantics. Final publication continues to use the existing stopped-output and checked diagnostic drain mechanisms; no new public error variants or global resource behavior are required.

## Qualification

Keep the failing two-real-map regression unchanged as a direct witness: no subsequent request, no prior presented mesh/hash/instance output, no final hooks, no callback replay and leases released. Also cover a real capped/refused-face source report carried by the second inner reply so the fix proves report delivery exactly once while output is discarded; existing source-before-numerical terminal-cancel regression is related but stops during request, not accept. Existing foreign-reply, source-B versus foreign-worker-A and owned first-fault regressions remain necessary to prevent a blanket ambient inheritance fix.

Source hashes: /tmp/ifclite-processing-terminal-8879-hashes.json. Runtime repair remains unimplemented/unrun by this reviewer.

## Parent repair verification

Reviewed committed bf9f12270dac0de4a25eced09d56991e093c1973 (one production path, six inserted lines). The implementation snapshots entrance_stop only after complete outer and inner reply/owner validation. For GeometryStep it selects the executed reply stop before the entrance fallback, calls resource::stop under the authenticated source epoch *before* program.accept, and retains normal real inner acceptance plus cancel_with_reports. The closure's existing terminal sample then feeds remember_stop, clearing prior presented output and preventing further requests. Non-GeometryStep behavior and global source/account isolation are unchanged.

No additional concrete authority, report-delivery or first-fault blocker found in this narrow repair. It follows the recommendation above without the dangerous early-drop path. Existing source-first resolution remains in resource::stop/SourceStopHandle; rejected replies are untouched. The actual failing real two-map regression remains unchanged and is still the primary runtime qualification obligation. No new test/build was run by this reviewer. Correction source hash is recorded separately below so the original diagnosis hashes retain their original inspected scope.
