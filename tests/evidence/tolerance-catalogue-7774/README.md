# Tolerance catalogue (#7774, F2c)

`value-drift.oracle.patch` is the revert-oracle mutation for the F2c PR. The PR adds the `math::tol` module (and `tol_tests`), which the migrated sites and the changed test import, so a whole-change revert does not compile (INCONCLUSIVE). The patch keeps the module and drifts two catalogue values (`POINT_COINCIDENT_EPS` 1e-9 to 1e-8, `F32_ULP_SCALE` 2^-22 to 2^-21), which `tol_tests::values_are_the_shipped_literals` must observe. Once `rust/geometry/src/math/tol.rs` is on `main`, the ordinary whole-change revert resumes.
