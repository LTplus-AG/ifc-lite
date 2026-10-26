#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Sourced by test.yml. Return success only when one of these leading
# retained-source observers wins; later workflow clauses handle the rest.
if git diff --name-only --diff-filter=A origin/main...HEAD -- rust/processing/tests/retained_inspection_busy.rs | grep -Fxq 'rust/processing/tests/retained_inspection_busy.rs'; then
  oracle_args=(--base a83992f426811f3e5ac3998bc74b8971f0b1cb55 --ci --json \
    --mutation tests/evidence/retained-source-inspection-c/busy-report.oracle.patch \
    --test rust/processing/tests/retained_inspection_busy.rs)
  return 0
elif git diff --name-only --diff-filter=A origin/main...HEAD -- rust/geometry/src/program/retained/frame_origin_tests.rs | grep -Fxq 'rust/geometry/src/program/retained/frame_origin_tests.rs'; then
  oracle_args=(--base e8667c3e91b5e77b536ecdfaa51af9a4d863ee96 --ci --json \
    --mutation tests/evidence/retained-frame-origin-b2c/value-report.oracle.patch \
    --test rust/geometry/src/program/retained/frame_origin_tests.rs)
  return 0
elif git diff --name-only --diff-filter=A origin/main...HEAD -- rust/geometry/src/program/retained/mapping_origin_tests.rs | grep -Fxq 'rust/geometry/src/program/retained/mapping_origin_tests.rs'; then
  oracle_args=(--base 54e0c22a7df946b8c5d8d6a0b08d8b64f6edef71 --ci --json \
    --mutation tests/evidence/retained-mapping-origin-b2a/occurrence-report.oracle.patch \
    --test rust/geometry/src/program/retained/mapping_origin_tests.rs)
  return 0
elif git diff --name-only --diff-filter=A origin/main...HEAD -- rust/geometry/src/program/retained/boolean_origin_tests.rs | grep -Fxq 'rust/geometry/src/program/retained/boolean_origin_tests.rs'; then
  # Keep the new private Boolean facts when B2a is already on main.
  # Removing reporting must fail an assertion, not test compilation.
  oracle_args=(--base e8667c3e91b5e77b536ecdfaa51af9a4d863ee96 --ci --json \
    --mutation tests/evidence/retained-boolean-origin-b2b/predicate-report.oracle.patch \
    --test rust/geometry/src/program/retained/boolean_origin_tests.rs)
  return 0
fi
return 1
