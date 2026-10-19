<!-- SPDX-License-Identifier: MPL-2.0 -->
# Opening-only repair after actual native execution

Frozen source repair `ad07f72a56e44cab0a3e1881d252a04c02bc469d` follows unchanged
`bcb0e55784` and evidence parent `50da6f5862`. Two test files change; no production
math, source coefficients, fixture, Precision, admission guard or region seam changes.
Root mapping/affine/resource failures remain outside this owned correction.

Actual parent source `1cefdab4966118967195422cd317ae38dd7b9922` executed native SDK
witnesses. Its current log reports invalid volume-query arguments in the overlap,
repeated-mapped and Reference opening witnesses, and a source-region refusal in
#3641. It also reports actual passing opening Empty/laziness/no-related Empty and
partial-stop witnesses. This is a parent-owned ongoing run, not a pass for this
repair. `parent-log-opening-excerpt.txt` is a numbered excerpt from one read snapshot;
`qualification.json` pins that snapshot's byte count/hash and source identity.

The repair changes all four opening witness volume-query arguments from 1e-10 to
the existing supported API minimum 1e-8, including the latent #3641 call. The
adapter's [1e-8,1e-1] API contract and all separate 1e-6 comparison oracles remain
unchanged. Runtime/native files are untouched. No repaired result has been executed.

The actual #3641 raw curve order `(1,2,3,4,5,1)` retraces the positive-length
interval [0,870] mm on its first and last edges in opposite directions. This is an
exact source overlap, not a near-contact resolved by reducing Precision. The new
source regression uses the production curve extractor, verifies those authored
coefficients, and requires the original profile/extrusion refusal without leaked
partial loops. It does not replace or qualify the existing positive SDK/Worker
trap witness, which remains red until dedicated source-retaining region work.

`source-coefficients.json` pins original records, fixture hash, f64 bits and exact
binary-rational overlap/area proof. The candidate boundary after exact canceled-span
decomposition is recorded only as a derived-operation plan, never as replacement
authored source. Its area identity is not an accepted region or SDK certificate.
`REGION-REGULARIZATION-PLAN.md` supplies the dedicated raw-source, derived operation,
exact decomposition, topology, provenance, resource and native/browser qualification
contracts requested for the full actual-model preservation goal. That work is not
implemented by this correction.

`repair.patch.gz` is the exact two-file incremental patch. Its bytes equal the
bcb0-relative diff restricted to those files; apply it to `50da6f5862`. A private
temporary Git index independently reconstructed ad07's full tree exactly.
`assembly-and-hashes.json` records the expected/reconstructed tree and before/after
SHA256 hashes. No parent/root file was overlaid and no real index/worktree was
changed by reconstruction.

Rust syntax-only parsing and whitespace checks passed. Exact Fraction arithmetic
on the immutable source coefficients produced the recorded metadata proof. Rust
compilation, tests, Clippy, repaired SDK/Worker numerics and performance remain
**UNRUN**. No build, heavy/fleet job, PR, push or deployment was performed.
