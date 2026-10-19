# A0 standalone source review

Candidate `6c7edd4d4cd7a0a5b1e60a5dc52809bbbca53da2`, exact base `067ef8327b7238a5eef106df722ad7e705c8ed18`. Read-only immutable Git-object comparison and delivery artifact verification. Exact per-path blob/SHA256 identities and function-comparison results are in `ifclite-a0-6c7-source-review-hashes.json`. All15 delivered source hashes/blobs matched. No source edits, checkout/index changes, builds, tests or jobs.

## Verdict

No source blocker found for this standalone test-isolation slice. It does not depend on ElementState or any later geometry program/resource/processing module. Its base-to-candidate diff is15 paths, +226/-64, matching assembly. It addresses the process-profile test contamination mechanism without changing exact numerical algorithms or numerical acceptance gates. Actual reconstructed A0 validation remains required; parent root83 passes or A1 results are not candidate qualification.

## Isolation and production preservation

The new test_caps module exists only through cfg(test). It keeps operation/element configuration in TLS and has a non-Send Scope restoring that configuration plus COUNT, OP_CAP, ELEM_COUNT, ELEM_CAP. Child threads do not inherit the override. Scope unwinding restores both configuration and operation snapshots, avoiding stale tiny caps on reused test workers. Existing locks remain for fixture diagnostics/reset coordination; safety against unrelated numerical tests now comes from not writing global CAP/ELEMENT_CAP, rather than assuming every reader takes that lock.

All unit-fixture process-global cap writes were migrated in the candidate. An immutable-tree setter search found only production setter definitions, the private test setters, private test-helper calls and the separately audited integration executables. No missed inline unit-test raw setter was found. Helper setter scope assertions and declaration order ensure restoration helpers drop while their test configuration remains installed.

The six production functions set_cap, set_element_cap, cap, element_cap, begin and begin_element compare exactly to base after removing only added cfg(test) statements. Default constants and actual process atomics are unchanged. Production environment precedence and per-operation/per-element snapshot behavior therefore remain the base behavior. Scoped explicit test configuration intentionally overrides environment-derived values only in that test thread, so fixtures can reliably exercise declared limits; no production profile was relaxed.

The extracted budget.rs registers only its cfg(test) helper and existing tests. There is no dangling budget_state.rs registration, ElementState reference/import or deleted production child path. The helper's migrated-state comment was correctly removed. New helper paths resolve relative to the base kernel directory, and base budget TLS/atomics/private access supplies everything they use. New modules are small; no allowance ceiling is raised.

## Tests and integration process boundary

The new concurrent test trips a real local cap2 operation while a neighbor without override starts real operation/element accounting from the process/environment profile. It checks actual snapshots, escalation/trip behavior and unchanged process atomics; it does not merely set and read a configuration field. Its single barrier keeps the low override alive during neighboring work without a second barrier that could hang after a worker assertion. The panic test trips actual accounting then requires the complete prior snapshot/configuration and global profile to survive unwind. Both remain unexecuted for this candidate.

The bool_failure integration binary links the production library, so cfg(test) library helpers would not apply there. The one cap-changing test now launches its exact existing top-level test name in the same executable with an explicit child marker, removes only the two budget environment overrides in that child, and requires one passing original test. The marker prevents recursion; --exact prevents sibling geometry execution while process caps change. The child retains every original geometry/escalation/fallback assertion and exercises the real public production setter API. The parent test never mutates its profile.

Remaining integration raw setters are issue_1109_budget (one test) and csg_model_profile (one ignored manual test). They already own their independent executable processes and cannot contaminate this libtest binary or bool_failure siblings. Leaving them unchanged is coherent. No production-public testing API or generic environment mutation was introduced.

## Oracle and evidence boundaries

No existing assert/assert_eq/assert_ne line was removed in the full candidate diff; numerical geometry fixtures, caps, tolerance constants, retry order, torn-edge ceiling and closed-surface expectations remain unchanged. The fixture edits are local cap API/scopes and explanatory comments, apart from the exact-child integration harness. Existing loops/numerical calculations still execute.

Parent reports A1 actual workspace5691 pass/1 existing N-ary failure/47 ignored and strict Clippy pass; parent root83 N-ary tests passed after isolation. These observations are consistent with the documented shared-global mechanism, but the original setter-overlap was not captured. This source review does not manufacture that missing execution trace, claim a mathematical union fix, or transfer either source's qualification to A0.

Delivery hash verification, six-function static equivalence and diff whitespace check passed in this review. No compile, parallel test, Clippy or performance result is asserted. Qualify the reconstructed A0 commit through normal fleet/workspace gates before landing; keep the original exact N-ary tests and zero torn-edge ceiling unchanged.
