# Tolerance literal ratchet preservation

Current root before correction: **498** counted epsilon literals. After: **480**.
The existing ceiling remains **480**; its scanner and source-file selection are unchanged.

Evidence: `before.json` / `after.json` owned-source hashes; original files in `before/`;
`after-count.json` plus `/tmp/ifclite-tolerance-before-count.json` per-file counts;
`policy-inventory.json` names, exact values, binary64 bits, units and reasons;
`token-preservation.json` executable-operand preservation checks.

Production changes name eight retained numerical-edge policies in math/tol.rs,
four repeated XY circular-axis tests with one local dimensionless constant, and
the two signed endpoints of one Taylor remainder interval with one local bound.
All threshold literals remain exactly the same binary64 values. No comparisons,
operation order, unit conversion, normalizing arithmetic, rejection strings,
control flow or admission order changes. Distinct metres/radians/relative/axis/
area/rectangle closure policies remain distinct even when their values coincide.
Swept-disk/helper line-direction degeneracy reuses existing DIRECTION_MIN_LEN in
the vector's own units. The circular trim upper endpoint uses existing PARAM_EPS,
whose declared curve-parameter units include radians, for the same endpoint margin.
The single-use relative trimmed-line parameter tolerance remains independent.

The complete retained_display inline test module is moved to the house-pattern
retained_display_tests.rs sibling, with its real IFC-backed narrowing/crease tests
unchanged modulo indentation. No production exclusion or special ratchet case is added.
Eight new exact-bit pins extend the existing tolerance value test; the gate ceiling
and walker logic are untouched. Seven edited executable source files were checked
against their originals after expanding only named literal operands and removing
new imports/declarations/comments/whitespace. The complete moved test body was
checked unchanged modulo indentation.

Lightweight validation only: `check.py` passed preservation checks. A standalone
Rust harness reuses the exact existing scanner and recursive file selection,
reports count480, asserts ceiling480, and verifies all eight new catalogue values
and two reused constants by f64::to_bits. It includes the actual tol.rs catalogue,
but does not compile the geometry crate or its consumers. `git diff --check` passes.
No Cargo build/test/Clippy, WASM build, numerical geometry test, fleet submission,
or performance run was attempted. Full combined-source qualification is UNRUN.
No numerical/performance improvement is claimed; this is preservation refactoring.
