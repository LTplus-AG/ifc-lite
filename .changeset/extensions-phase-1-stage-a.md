---
"@ifc-lite/extensions": minor
---

Phase 1 Stage A — host-agnostic library layer for the extension system.

New modules:

- **Storage** (`/storage`) — `ExtensionStorage` interface,
  `InstalledExtensionRecord` type, `InMemoryExtensionStorage`
  implementation for tests/CLI, SHA-256 bundle hashing via WebCrypto.
- **Host** (`/host`) — `ExtensionLoader` (composes storage + manifest
  validation + slot registry + activation dispatcher), and
  `ActivationDispatcher` (event-driven at-most-once activation per
  session, with sequential async listener semantics).
- **Audit** (`/audit`) — append-only ring buffer with byte + count
  caps, JSON export, filter API for the future security review UI.
- **Inference** (`/inference`) — acorn-based AST walker that turns a
  saved script into a minimum capability set for the "Promote to tool"
  UX. Conservative: ambiguous calls over-grant rather than under-grant.

Dependencies added: `acorn` and `acorn-walk` (tiny, standard ES parser
used by ESLint/Webpack/Babel; chosen over zero-dep regex to avoid
under-granting on edge cases).

UI integration (viewer-side React provider, Promote-to-Tool dialog,
capability review screen, Settings → Extensions page) and the
sandbox capability bridge are intentionally not in this changeset.
They land in the next batch where browser interactivity is verifiable.
