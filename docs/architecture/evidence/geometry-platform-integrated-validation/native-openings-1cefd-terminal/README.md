<!-- SPDX-License-Identifier: MPL-2.0 -->

# Actual native/opening qualification at 1cefd

This is the complete failed run with the actual freshly built SDK worker explicitly configured for Rust consumers. Five of six CTests pass; the owned boundary rejects the constructed clipping-plane basis/origin. The independent sixth copy-observability boundary passes, establishing only its original frozen witness. The later event-time ledger and paired splitting remain unqualified.

Rust SDK consumers report 1,321 passed, 12 failed, and five ignored. Geometry controls separately report 1,942 passed, zero failed, and one ignored. Strict workspace/all-target Clippy passes. The overall command exits 8; source remains unchanged. See `summary.json` for all failed tests and distinct causes under investigation. Expected panic messages in passing unwind tests are not counted as failures.

The original strict checks, numerical oracles, immutable source, raw receipt and complete output are preserved. Invalid fixture API requests must be repaired independently from numerical code. The authored contour's exact positive-length backtracking is a real supported-domain gap; it cannot be fixed by reducing Precision. Canonical browser, generated-artifact, cross-platform, final-product and performance qualification are not established.

The archive is lossless: decompress `output.log.gz` and compare its SHA256 with `summary.json`. Nothing here repins golden output, suppresses refusal, or qualifies a subsequent source change.
