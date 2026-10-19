<!-- SPDX-License-Identifier: MPL-2.0 -->
The original PR #7946 observation run (39226056638, job 117976366783)
reported INCONCLUSIVE: whole-production inversion removed the new test-cap API
while leaving its migrated test callers, producing unresolved `test_caps` imports.
This is not a behavioral witness or a passing oracle result.

The workflow now selects a compiling mutation while this module is newly added:
keep the test-cap API and remove configuration restoration from Scope::drop.
The existing unwind test compares the actual operation/configuration snapshot
with its pre-scope value and must fail. Every changed test still runs; no test
selection, timeout, assertion, tolerance or required gate is waived. Once the
module is present on main, ordinary inversion resumes.

Patch application and whitespace checks passed locally. The actual baseline
and mutated Cargo runs remain pending admitted execution/CI. Existing workspace
qualification remains bound to its original source, unchanged by this record.
