# Canonical native summary acceptance — #6537

Run [37180013485](https://github.com/LTplus-AG/ifc-lite/actions/runs/37180013485)
used controller `105f4abb0a9a4b32e540abeaa3c76c7ab50d282f`, literal base
`187a72e3302447fc49f2264111501223238a24a7` and candidate
`672f1e09c06ce777507244d2f2c4403d7b38c098`. Its functional controls, held-FD
startup, both fresh native builds and original-arm command qualification passed.
The first Haus base process exited successfully and retained canonical output,
but the cohort rejected its nonempty stderr. The pinned `print_human` emits that
summary before JSON even with `--json`. This is a controller contract defect.
The original run remains **REFUSED**, with no completed pair and no timing verdict.

The correction validates the ordered, single-fixture, non-cold/non-census summary
against the already validated JSON and frozen fixture bytes. It retains raw stderr
and rejects unknown, repeated, missing, reordered, warning/error/compiler lines.
Integer phase/count data and five ordered totals, walls and FNVs must match.
Fixed decimal displays certify half-quantum intervals with explicit tie endpoints
and scaled f64 representation slack. File sizes bind to actual fixture bytes.
The scan percentage truncates the original scan duration, whose JSON and human
displays have different precision; their interval intersection bounds possible
integer numerators at a rounding boundary.

The CSG product count is emitted only in the human summary. It is retained
separately and compared across paired controls and samples. Its bound is supported
by `record_csg_failures` rejecting empty batches, the native collector merging
those records, and `count_attributed_products` excluding the unattributed bucket.
Consequently zero attributed products can coexist with nonzero failures; each
counted product contributes at least one total failure. Cache/timing statistics
are retained but are not mistaken for failure attribution.

Finite correctness qualification passed all 19 selected controls: nine new
summary controls and ten directly affected native protocol controls. Tests use
the byte-exact Haus output from the refusal and previously retained real CSG and
Holter output. The old captures' one Cargo freshness prefix remains in the raw
fixture; only the named historical test adapter extracts the summary component.
Production FD summaries refuse that prefix. Constructed optional/quantization
cases are stated invariants, not claims about new model runs.

Lint, syntax, module-size, test-wiring, license, diff and source-text gates pass.
The initial missing-TypeScript source-gate prerequisite refusal is preserved.
Only the previously approved gitignored dependency symlink for that AST gate was
used; there was no installation, package typecheck, model load or subject build.
The raw source pins remained unchanged throughout qualification. FD witness
verification, normal cadence, commands, resource/noise floors and cleanup policy
remain mandatory and unchanged. Corrected-source hosted qualification is **UNRUN**.

`receipts.tar.gz` retains full failed-run APIs, job log, all artifact bytes, source
proposal and functional/gate receipts. `manifest.json` names every member's
original path, size and SHA-256. The reader is byte-identical to the already
qualified held-FD evidence reader; it validates bounded, safe extraction and never
executes archived code:

```sh
python3 scripts/perf/evidence/native-canonical-summary-6537/safe-extract.py /tmp/native-summary-receipts
```

The extraction and independent direct-original byte comparison establish retained
data integrity. They establish no new performance result, model correctness,
worker-pool benefit, complete appearance identity or adversarial machine closure.
