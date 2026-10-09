# Separate requested-current-runtime check

The root Turbo Bonsai-only control on clean source `6e115f8c` passes with identical actual primary/peer geometry fingerprints. The controller witnesses the same source head before and after, but its runtime guard refuses the requested8b label: the pre-run8b WASM was replaced by the loose-mode cached b335 runtime before the test. Exact pre/post hashes and the raw passing control are retained separately. This is not qualification of8b, and does not replace or relabel the prior78-control b335 receipt.

No loop, forced Rust rebuild, full suite, repeated typecheck or native browser/performance measurement was used.
