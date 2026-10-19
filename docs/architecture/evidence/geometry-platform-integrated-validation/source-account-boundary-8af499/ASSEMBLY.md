<!-- SPDX-License-Identifier: MPL-2.0 -->
# Actual geometry account boundary

The exact 24-file source delta from 7628bf9a to 8af4994f was applied as an incremental patch after verifying it applies cleanly. All integrating file hashes reproduce the frozen child after-hashes. Existing generated bindings and unrelated numerical repairs are preserved.

This adds an opt-in paired resource interface, direct geometry ledger categories and standard accounted metadata ownership. It does not activate tracked parser/cache owners or authenticate source from resource identity. The full contract is rust/core/SOURCE_RESOURCE_ACCOUNT_BOUNDARY.md.

All new compilation, behavior, feature packaging and Clippy checks remain UNRUN. A fresh independent source review is active; previous 31-test qualification belongs to source26354 and is not transferred here. Metadata module-size and whitespace checks pass. Full owner/cache/COW/public API migration and production region binding remain required.
