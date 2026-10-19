<!-- SPDX-License-Identifier: MPL-2.0 -->
# Response to independent review of 7368cb32e9

All three requested repairs are implemented in source. **Independent closure is
pending; behavioral tests and actual A/B remain UNRUN.** The reviewed checkpoint
and its evidence were not rewritten. This response claims no new runtime result.

1. **P1 — source/fleet binding.** `exact-route-source.mjs` resolves full commits,
   computes original and execution trees from Git, permits only the exact added
   overlay, hashes every relevant execution blob and all worker toolchain inputs.
   `exact-route-receipts.mjs` compares those independent values to every recorded
   source field and consumes externally supplied original terminal fleet receipts.
   It requires successful completion, clean unchanged snapshots, matching tool
   identities/command/cwd and the worker output-log hash with exactly one final capture-receipt SHA256 marker.
   Preparation commits the overlay to allow honest clean fleet snapshots. Tests
   mutate trees/maps/blob hashes (including omission/extra entries), actual Git
   source content, dirty/changed snapshots and output-log/command binding. Receipt
   mutation fixtures deliberately rebind their synthetic output-log hashes/markers, so label
   self-consistency cannot stand in for the independent Git checks.

2. **P2 — profile/effective compiler settings.** `exact-route-compiler.mjs` rejects
   every profile override key by prefix, including panic/debug-assertions, future
   names and empty values. Flags/compiler/target inputs remain recorded. The
   pinned wrapper logs actual compiler identities and full argument arrays before
   execution; verbose Cargo/artifact logs, observed example profile/features,
   effective policy and saved executable are bound by hashes. Additional wrappers
   and unobserved cached main-example compilation refuse. Main-source mtime only
   is refreshed to force observation; no source bytes or arithmetic are modified.
   Tests cover overrides, flags, altered profile/panic, missing reached compilation,
   cached-main artifacts and tampered compiler evidence. Cached dependencies remain
   explicitly identified by Cargo artifact events, without a fresh-build claim.

3. **P2 — options and paired malformed capture.** `exact-route-schema.mjs` validates
   required records, full typed numeric payloads, dimensions/ranges, instance/frame
   shapes, metadata and loss diagnostics before ordered comparison. v2 captures
   normalize nullable serde-skipped fields to explicit null so missing fields
   cannot masquerade as absence. Captured options must match both the manifest and
   fixed ordinary-process_geometry contract. Negative tests include paired identical
   skeletal/truncated/mistyped/nonfinite captures and paired changed options, even
   with internally rebound capture/receipt hashes. Original bit, UV, texture,
   metadata, frame, occurrence-order and duplicate-loss negatives remain.

Source modules remain below 400 lines and carry MPL notices. Existing root
node-tests wiring reaches all supplied test files. No production API, arithmetic,
consumer selection, native/runtime/common/region/oracle tests, job, push, PR or
cleanup was performed. The active parent workspace run was left alone. Nonempty
instancing and actual federation remain unwaived release requirements.
