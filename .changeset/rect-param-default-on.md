---
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
---

Flip the PARAMETRIC rectangular-opening fast path (`IFC_LITE_RECT_PARAM`) to
DEFAULT ON. The path subtracts rectangular openings as exact parametric boxes
in the host wall's own placement frame (rotated walls included), producing a
watertight, analytically exact cut and deferring any non-clean case (non-rect
host or opening, frame mismatch, mesh/parametric disagreement, overlap,
engulfing redundant void) to the exact kernel unchanged.

Corpus-validated before the flip with a new A/B harness
(`rust/geometry/tests/rect_param_validate.rs`, run over AC20-FZK-Haus,
dental_clinic, advanced_model, ISSUE_068 and ISSUE_129): every element where
the path does not fire is byte-identical ON vs OFF (24,345 of 24,744 jobs;
the rest fired), and every fired host (399 across the corpus) is watertight
and matches the analytic box-minus-boxes ground truth within 0.5%. On firing
hosts the output is MORE correct than the exact kernel on engulfing-opening
walls (the kernel's documented 9-34% over-cut), so fired geometry is not
byte-equal to the old kernel output by design.

`IFC_LITE_RECT_PARAM=0` (native) and `setRectParamFastPath(false)` (wasm)
remain as opt-out escape hatches for the parametric path alone, and
`IFC_LITE_RECT_FAST=0` stays the global rect-fast kill switch: it disables the
legacy AND the parametric path, so that single flag still forces every
rectangular opening through the exact kernel (parity debugging / bisection).
wasm reads no env, so both targets default ON in lockstep and the native==wasm
byte contract is preserved.
