#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Sourced by test.yml. Return success only when one of these leading
# retained-source observers wins; later workflow clauses handle the rest.
if git diff --name-only --diff-filter=A origin/main...HEAD -- rust/processing/tests/retained_inspection_busy.rs | grep -Fxq 'rust/processing/tests/retained_inspection_busy.rs'; then
  oracle_args=(--base 0b353d3294d4f813b3d9f16574442ff7cc19da58 --ci --json \
    --mutation tests/evidence/retained-source-inspection-c/busy-report.oracle.patch \
    --test rust/processing/tests/retained_inspection_busy.rs)
  return 0
elif git diff --name-only --diff-filter=A origin/main...HEAD -- rust/geometry/src/program/retained/frame_origin_tests.rs | grep -Fxq 'rust/geometry/src/program/retained/frame_origin_tests.rs'; then
  oracle_args=(--base 3190e3d88bee5e83a45ca155c62620c61b27456b --ci --json \
    --mutation tests/evidence/retained-frame-origin-b2c/value-report.oracle.patch \
    --test rust/geometry/src/program/retained/frame_origin_tests.rs)
  return 0
elif git diff --name-only --diff-filter=A origin/main...HEAD -- rust/geometry/src/program/retained/mapping_origin_tests.rs | grep -Fxq 'rust/geometry/src/program/retained/mapping_origin_tests.rs'; then
  oracle_args=(--base 08769566858267aff3028f3f7c0e2870345ff73a --ci --json \
    --mutation tests/evidence/retained-mapping-origin-b2a/occurrence-report.oracle.patch \
    --test rust/geometry/src/program/retained/mapping_origin_tests.rs)
  return 0
elif git diff --name-only --diff-filter=A origin/main...HEAD -- rust/geometry/src/program/retained/boolean_origin_tests.rs | grep -Fxq 'rust/geometry/src/program/retained/boolean_origin_tests.rs'; then
  # Keep the new private Boolean facts when B2a is already on main.
  # Removing reporting must fail an assertion, not test compilation.
  oracle_args=(--base 3190e3d88bee5e83a45ca155c62620c61b27456b --ci --json \
    --mutation tests/evidence/retained-boolean-origin-b2b/predicate-report.oracle.patch \
    --test rust/geometry/src/program/retained/boolean_origin_tests.rs)
  return 0
fi
return 1
