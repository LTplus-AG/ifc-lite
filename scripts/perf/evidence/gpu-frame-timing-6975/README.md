# GPU frame timing qualification (#6975)

This first stack slice wires opt-in renderer timestamp queries and bounded readback
ownership into the real-GPU rig. It does **not** complete #6975. Native GPU query,
device-loss/recovery, image and real-IFC qualification remain outstanding. Physical
nightly scheduling, seven consecutive actual nights, reviewed alert thresholds and
demonstrated-repeatable M4 ceilings belong to the subsequent same-issue slices.

The source base is `7acd7e1d1dc30432fe59cde8aa9b8753f77b4013`; Rust is unchanged.
`initial-controls/renderer-receipt.json` and `tools-receipt.json` bind the two
qualification stages to exact source SHA-256s. The final renderer files remain
byte-identical to the earlier frozen renderer qualification.

- Root Turbo renderer controls: 2,051 pass, two skips, zero failures. The explicit
  CPU protocol oracle checks map ownership/cancellation; it is not native GPU proof.
- Corrected plain root typecheck: zero exit, 3,713 test files across 62 packages,
  plus the permanent frame-tools no-emit programme reached after Turbo.
- Final host/CLI controls: six pass, zero skips. These include real Windows
  PowerShell running the production encoded collector with a controlled unavailable
  CIM provider, and an actual competing Linux process observed through `/proc`.
- Epoch reset inverse: one assertion fails when configuration reuses the previous
  epoch. CPU null-coercion inverse: one assertion fails when `[double]$null` becomes
  an invented zero CPU observation. Both production sources were restored exactly.

The initial tools programme failed on a missing renderer declaration path and an
inherited overly broad numeric dictionary annotation in the benchmark helper. The
corrected programme passes. The early CIM provider used a WSL environment variable
that was not forwarded to Windows: that log proves only null-field refusal, and is
excluded from cardinality claims. The final provider explicitly transfers its mode.

The retained real Windows observations show sensor availability only. CPU samples
were 31%, 11% and 9%; they do **not** admit a quiet run. GPU engine percentages are
raw observations with no qualified GPU quiet threshold, and are never summed into
adapter utilization. There is no performance verdict or accepted nightly result.
