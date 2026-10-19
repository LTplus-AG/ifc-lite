<!-- SPDX-License-Identifier: MPL-2.0 -->
# Imported geometry artifact recovery

The owned delivery `f3fa41ffc739` is based on `55f3d3aa285`. Its twelve-file
incremental patch and file hashes are recorded in `handoff.json`; the original
patch and logs are losslessly compressed alongside the original receipts.
Parent integration verified all twelve file hashes, then independently passed
the Rust-free artifact verifier, three provisioning/publication fixtures and the
global license-header gate. No numerical Rust algorithm changed in this delivery.

Independent review also reproduced seven real-scene and eight direct raw-bit
comparisons against the authenticated pre-migration `86adb595c0` capture. The
comparison verifies original fixture, harness and captured-output identities.
Those scenes do not witness textured meshes or non-null georeferencing.

The source-pinned child consumer run passed repeat artifact generation/verification
without source changes and 229 IFCX tests with no skips. Its subsequent full
typecheck failed on the inherited private-field accesses fixed separately by
parent `27b0e367e7`; that failed run is not a passing root typecheck. The extended
comparison job was refused admission before execution. Both outcomes are retained.

Immediate-parent comparison passed thirteen numerical cases and one error case,
then failed when the parent's stale committed artifact rejected a real graph
packet. This is retained in `immediate-parent.log.gz`. Source regeneration of that
exact parent is still needed for immediate-parent attribution; the old artifact
failure is not evidence of a candidate geometry regression.

Generated publication stages and validates outputs before replacement and rolls
back synchronous replacement errors. It is not a crash-safe directory exchange:
two renames briefly leave the destination absent. Fleet serialization remains
necessary for concurrent builds of one checkout.

These receipts do not qualify assembled-source root checks, actual browser
Workers, installed-package closure, USD export/reopen, cross-platform support or
performance. Every recorded generation input, including Cargo.lock, must still
match; a later change requires regeneration rather than editing provenance.
