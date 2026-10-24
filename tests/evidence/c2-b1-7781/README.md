<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# C2-B1 bound-and-report oracles (#7781 / #8020)

Status: **prepared, NOT EXECUTED; pending admitted G-X qualification**.
The patches use the revert oracle's reverse-apply orientation. They preserve
all public APIs and tests, avoiding a compile failure from reverting the API
change instead of measuring behaviour.

- `bound.oracle.patch` disables both independent Expand admission comparisons.
  The exact-allowance, root precharge, nested precharge, level-meter and DAG
  regressions must fail on excess decoding/visits or missing budget refusals.
  The generated DAG is small even without the bound; this mutation does not
  require a hang to demonstrate the defect.
- `report.oracle.patch` retains the bounds, terminal stops and unwind, but
  discards the three refusal callbacks. The same work-budget tests must fail
  because the expected entity, Budget payload and context are absent.

`.github/workflows/test.yml` selects the bound mutation in the ordinary oracle
chain and invokes the report mutation separately with `work_budget_tests.rs`.
Each oracle runs the positive baseline before its mutant. Both must return an
observed behavioural failure, never a build error, broken baseline or vacuity.
After admission, record original request/receipt IDs, exact source commit,
commands and observed failing assertions in the qualification artifact. No
execution, corpus maximum, perf verdict or semver measurement is claimed here.

Commands to run on the clean committed head through the registered launcher:

```sh
node scripts/check-test-revert-oracle.mjs --base cf892ea4 --ci --json --mutation tests/evidence/c2-b1-7781/bound.oracle.patch
node scripts/check-test-revert-oracle.mjs --base cf892ea4 --ci --json --mutation tests/evidence/c2-b1-7781/report.oracle.patch --test rust/geometry/src/representation/work_budget_tests.rs
```

The final review/landing qualification must use the then-current main as base
and rerun both on the exact final head if rebased or merged again.
