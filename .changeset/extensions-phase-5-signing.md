---
"@ifc-lite/extensions": minor
"@ifc-lite/cli": minor
---

Phase 5 prototype — Ed25519 signing for extension bundles.

The hosted registry is gated on a decision criterion (50 flavors / 10
authors before opening), but the cryptographic kernel ships today so
the design isn't abstract and authors can sign bundles before any
registry exists.

New design doc:
`docs/architecture/ai-customization/10-registry-and-signing.md` —
distribution threat model, signing scheme, key management, signed
envelope shape, verification flow, registry architecture sketch,
trust UX (TOFU), revocation, phase 5 build plan, non-goals, open
questions.

New `@ifc-lite/extensions/signing` module:

- **Keys** — `generateKeyPair`, `exportPublicKey`, `exportPrivateKey`,
  `importPublicKey`, `importPrivateKey`, `fingerprintFromBytes`.
  Uses WebCrypto Ed25519 (Node ≥ 18.17, modern browsers). Keys
  serialise as `.iflk` JSON files with format/version/algorithm
  discriminator. Fingerprints are colon-separated SHA-256 of the
  raw 32-byte public key.
- **Canonical hashing** — `canonicalContentHash` produces a
  deterministic SHA-256 over the bundle's file map. Insertion-order-
  independent; uses ASCII unit/record separators between
  path/bytes/record to make segment boundaries unambiguous.
- **Sign / verify** — `signBundle` produces a `SignatureBlock`
  committed to the canonical hash. `verifyBundle` recomputes, checks
  format, imports key, runs `crypto.subtle.verify`. Throws
  `SignatureMismatchError` on any failure;
  `SignatureFormatError` for envelope-shape problems;
  `KeyFormatError` for malformed key files.

`.iflx` envelope extension:
- Optional `signature` field on pack / unpack.
- `packBundle(bundle, signature?)` accepts a signature argument.
- New `unpackBundleWithSignature(bytes)` returns
  `{ bundle, signature? }` so callers (loader, CLI) can verify and
  display the signer fingerprint.
- Existing `unpackBundle` continues to work — signed bundles unpack
  fine, the signature is silently ignored. Backward-compatible.

New CLI subcommands under `ifc-lite ext`:
- `keygen --out <prefix> [--label <name>]` — Ed25519 keypair, writes
  `.public.iflk` and `.private.iflk`. Best-effort POSIX 0600 on the
  private file.
- `pack <bundle-dir> [--out <bundle.iflx>] [--sign --key <private.iflk>]`
  — pack a bundle directory into `.iflx`, optionally signed.
- `sign <bundle> --key <private.iflk> [--out <bundle.iflx>]` —
  attach a signature to an existing bundle (directory or unsigned
  `.iflx`).
- `verify <bundle.iflx> [--key <public.iflk>] [--json]` — inspect
  a `.iflx`, optionally checking the signer matches an expected
  public key. JSON mode emits a structured envelope.

Package-side housekeeping:
- `packages/extensions/tsconfig.json`: added `"DOM"` to `lib` so
  WebCrypto types (`CryptoKey`, `CryptoKeyPair`) are available. Was
  already implicitly required for `crypto.subtle` calls in
  `storage/hash.ts`.
- Top-level barrel exports the new signing surface.

Tests: 333 (up from 307 / +26). New coverage: keypair generation
identity, public/private key file round-trip, canonical hash
determinism and order-independence, sign+verify happy path,
content tamper detection, contentHash tamper, substituted public
key, algorithm/format error paths, signed `.iflx` envelope
round-trip, tamper detection through the pack→unpack→verify chain.
Smoke-tested end-to-end against the canonical `good` bundle
fixture.

Plan tracked in `09-implementation-plan.md` — P5.T2 closed,
P5.T1/T3-T8 remain gated on the registry decision.
