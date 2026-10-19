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

Merge reconciliation: main's #7024 now supplies TestProfile and the migrated
unit fixtures. This branch retains that implementation verbatim and deletes
its superseded test_caps module, workflow exception and mutation patch.
Additional concurrency/unwind witnesses now use TestProfile and are registered
from the existing test-only budget_tests module. The subprocess public-setter
witness remains. Historical qualification above does not qualify this merge;
CI must execute the adapted tests. Fleet admission is currently refused on both
hosts (guard 78), so no new local Cargo pass is claimed.
