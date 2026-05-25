# 10 — Registry & Signing

Status: **Design + Phase 5 prototype.** Cryptographic primitives and CLI
land in this RFC turn so the design isn't abstract. The hosted registry
is gated on the Phase 5 decision criteria (≥ 50 exported flavors and
≥ 10 distinct authors before opening). Once opened, this document is
authoritative.

This document picks up where `02-security.md §10` and `05-flavors-and-sharing.md §7`
left off: how community-published extensions and flavors are signed,
distributed, verified, and revoked.

## 1. Goals

- **Author identity that survives bundle copies.** If Alice publishes
  extension X, anyone who later reinstalls X (from a friend, a forum
  link, a hosted registry) should see "signed by Alice" — and detect
  any post-publish tampering.
- **Trust on first use (TOFU).** The host remembers which signer keys
  the user has installed extensions from before. New keys are flagged;
  matching keys reassure.
- **Distribution-agnostic.** The signature lives inside the `.iflx`
  envelope. A bundle is the same bundle whether it came from a hosted
  registry, a GitHub release, an email attachment, or a flavor bundle's
  embedded payload.
- **Registry as an add-on, not a gatekeeper.** Signed bundles work
  without any registry. The registry adds discovery, ratings,
  takedown, and CI scans — none of which the cryptographic layer
  depends on.
- **No PKI.** No certificate chains, no central CA. Each author owns
  their keys. The local trust store records "I trust this key because
  I have installed N extensions from it before."

## 2. Threat model (distribution layer)

We extend the threat model in `02-security.md §1` with adversaries
specific to bundle distribution.

- **D1 — Bundle tamper in transit.** Someone modifies a `.iflx` between
  the author and the user. Counter: signature on canonical content
  hash; verify on install.
- **D2 — Author impersonation.** Someone publishes an extension
  claiming to be the maintainer of a well-known one. Counter:
  signature comparison + key fingerprint visible to the user; TOFU
  history.
- **D3 — Registry compromise.** A hosted registry is breached and
  ships malicious bundles. Counter: signatures are author-held — a
  compromised registry cannot mint valid signatures for an author's
  key. Compromised registries can still serve malware signed with
  *their* fake keys; TOFU + key publication elsewhere (author's
  website, GitHub) mitigates this.
- **D4 — Stolen author key.** An attacker gains access to a
  developer's private key. Counter: kill-switch list of revoked
  fingerprints baked into the host build; on next launch the host
  refuses to load extensions signed by revoked keys.
- **D5 — Algorithm break.** Future cryptanalysis of Ed25519. Counter:
  algorithm versioning in the envelope (`signature.algorithm`) so we
  can roll forward without breaking older bundles.
- **D6 — Replay / downgrade.** Attacker substitutes an older signed
  version with known vulnerabilities. Counter: every signature
  commits to the manifest's `version` field; the host refuses to
  install a version less than the highest already-seen for the same
  `id + signer`.

## 3. Signing scheme

### 3.1 Algorithm

**Ed25519.** Reasons:

- Built into WebCrypto in modern Node (≥ 18.17) and browsers (Chrome,
  Safari, Firefox 130+).
- 32-byte public keys, 64-byte signatures — small enough to embed in
  every envelope without bloating bundles.
- Deterministic — same input + same key → same signature. Property
  matters for content-addressing.
- Mature, no known weaknesses.

Algorithm identifier in the envelope: `"ed25519"`. Future algorithms
add new identifier values; the host's verifier rejects unknown
identifiers explicitly.

### 3.2 What gets signed

The **canonical content hash** of the bundle: a SHA-256 over a
deterministic serialisation of `{ files: sorted-by-path }`. The
serialisation:

```
for each path (sorted ASCII ascending):
   append: utf8("path") || 0x1f || file_bytes || 0x1e
```

(`0x1f` is the ASCII unit separator, `0x1e` the record separator;
neither appears in path names — they are control characters.)

Excluded from the hash: the `signature` field itself. The bundle is
signed *before* the signature is embedded.

### 3.3 Envelope shape (signed `.iflx`)

```jsonc
{
  "format": "iflx",
  "version": 1,
  "files": { /* path → base64 */ },
  "signature": {
    "algorithm": "ed25519",
    "contentHash": "<hex sha256 of canonical content>",
    "publicKey": "<base64>",
    "signature": "<base64>",
    "signedAt": "<ISO timestamp>"
  }
}
```

Unsigned `.iflx` bundles omit the `signature` field entirely. The
unpacker handles both shapes; signed bundles return a
`SignatureInfo` block alongside the `Bundle` so callers (review
screen, CLI) can display the signer fingerprint.

### 3.4 Fingerprint

The **fingerprint** of a public key is `SHA-256(raw-32-byte-key)`,
displayed as colon-separated hex pairs:

```
8f:a1:c3:...:42  (32 pairs, 64 hex chars + colons)
```

Fingerprints are what users see; full public keys are an implementation
detail. The first 8 pairs (16 chars + colons) are sufficient for
visual comparison in compact UI; the full fingerprint is exposed in
"details" panels.

## 4. Key management

### 4.1 Key files

The CLI emits keys as JSON files for portability across operating
systems. Two files per author identity:

```json
// alice-public.iflk
{
  "format": "iflk",
  "version": 1,
  "kind": "public",
  "algorithm": "ed25519",
  "publicKey": "<base64-raw-32-bytes>",
  "label": "Alice Example",
  "createdAt": "2026-05-16T12:00:00.000Z"
}
```

```json
// alice-private.iflk
{
  "format": "iflk",
  "version": 1,
  "kind": "private",
  "algorithm": "ed25519",
  "privateKey": "<base64-pkcs8>",
  "publicKey": "<base64-raw-32-bytes>",   // included for convenience
  "label": "Alice Example",
  "createdAt": "2026-05-16T12:00:00.000Z"
}
```

Private key files are sensitive. The CLI scaffolder sets `0600` on
POSIX and prints a clear warning. We will never recommend that users
check private keys into source control.

### 4.2 No central registration

Anyone can generate a keypair locally. There is no signup with us,
with a central server, or with anyone. The fingerprint *is* the
identity.

When the (future) registry opens, accounts there are tied to *one or
more* fingerprints the account owner registers — the account is the
discoverability layer, not the trust layer.

### 4.3 Rotation

Keys do not expire. To rotate:

1. Generate a new keypair.
2. Sign the next bundle release with both keys (envelope.signature
   becomes an array of length 2 — see §3.3 note on future shapes).
3. Publish the new fingerprint via the same channels you publish bundle
   releases.
4. After a transition window, drop the old key.

Phase 5 ships single-signature envelopes only. Multi-signature
envelopes are post-1.0; the format reserves room for them by treating
`signature` as a potential array in a future minor version.

### 4.4 Revocation

When an author key is known compromised, the fingerprint goes on the
host's **revocation list** — a hardcoded set in the host build,
shipped with every release. On next launch, the host:

- Refuses to activate extensions whose stored signature matches a
  revoked fingerprint.
- Surfaces a banner: *"Extension X was signed by a key that has been
  revoked. It is disabled."*
- Offers the user a one-click uninstall.

This is a last-resort mechanism. The list is owned by the IFClite
maintainers; community-contributed entries land via the standard
PR process plus a security review.

## 5. Verification flow

```
.iflx bytes
   │
   ▼
gunzip → JSON envelope
   │
   ▼
shape check (format + version recognised?)
   │
   ▼
files map → Bundle.files (existing)
   │
   ▼
if envelope.signature:
   compute canonical content hash
   if hash != signature.contentHash → SignatureMismatchError
   import public key from signature.publicKey
   crypto.subtle.verify(signature.signature, contentHash)
   if fail → SignatureMismatchError
   if fingerprint(publicKey) ∈ revocation list → SignatureRevokedError
   produce SignatureInfo for the loader / UI
otherwise:
   no SignatureInfo; bundle is "unsigned"
   │
   ▼
existing manifest validation + cross-reference checks
   │
   ▼
Bundle + (optional) SignatureInfo handed back
```

The loader uses `SignatureInfo` to:

- Display the signer fingerprint on the install / details screen.
- Mark the bundle as "signed" in the audit log on install.
- Refuse re-installs of older versions from the same signer (§D6).
- Refuse installs from revoked fingerprints (§D4).

## 6. Trust UX

### 6.1 Install / review screen

A signed bundle adds a row to the existing capability review screen:

```
Signed by:  alice@example.com
Fingerprint:  8f:a1:c3:5e:7b:90:42:11  ...
Status:  ✓ New signer  (or: ✓ 4 extensions from this signer)
```

For an **unsigned** bundle: the install screen shows a yellow banner —
*"This bundle is not signed. You can install it, but updates will not
be authenticated. Prefer signed bundles for anything you didn't
author yourself."*

### 6.2 TOFU history

On install of a signed bundle, we add (or increment) an entry in an
IndexedDB-backed `signer-history` store:

```ts
interface SignerHistoryEntry {
  fingerprint: string;
  firstSeenAt: string;   // ISO
  lastSeenAt: string;
  installCount: number;
  // Optional author-supplied display label from the key file.
  label?: string;
}
```

The store is local-only. Subsequent installs that match the fingerprint
get the cheerful row; new fingerprints get the cautious one. The user
can review the history in a future "Signers" tab (post-Phase-5 UI).

### 6.3 Updates and version downgrade

When a user updates an extension:

- If the new bundle is signed by the same fingerprint as the existing
  install **and** its `version` is greater, the update proceeds (with
  the capability-diff review screen).
- If the new bundle is signed by a *different* fingerprint, the user
  sees a strong warning: *"This update is signed by a different key
  than the version you have installed. This is unusual — proceed only
  if you trust the new signer."* Requires typed confirmation.
- If the new bundle's `version` is less than what's installed (from
  the same signer), the install is refused as a replay / downgrade
  attempt. The user can manually override with a CLI flag.

## 7. Registry architecture (sketch — Phase 5 build)

The hosted registry is intentionally minimal. Two read endpoints, one
write endpoint, plus a webhook for kill-switch updates:

```
GET   /v1/extensions/<id>            → metadata + version list
GET   /v1/extensions/<id>/<version>  → signed .iflx bundle (binary)
POST  /v1/extensions                 → publish (auth required)
GET   /v1/kill-switch                → list of revoked fingerprints
```

Authentication for publish: the publisher signs a short challenge
nonce with their private key; the server verifies against a
fingerprint registered on their account at signup. No passwords on
the publish path.

### 7.1 Storage layout

Bundles are content-addressed by their SHA-256. The metadata table
maps `(id, version) → bundleHash → bytes`. Hash collisions are
detected on insert (refuse to publish if the proposed bundle hash
collides with an existing one).

### 7.2 CI on publish

Every published bundle runs through:

- Signature verification (the registry verifies what the client signed).
- Manifest validation (`ifc-lite ext validate`).
- Capability hygiene check (no `network.fetch:*` without explicit
  per-host pattern; no `model.mutate:*` wildcards without owner
  justification noted in the listing).
- Lint pass on JS code (`eval`, `Function(...)`, banned globals).
- Test pass against canonical fixtures (a curated subset of
  `tests/models/` lives in the registry's CI runner).
- License declared (SPDX).
- Manifest changelog field populated.

Publishes that fail any check are rejected with a structured response
the CLI surfaces to the author.

### 7.3 Lanes

The listing UI shows two lanes:

- **Editorial pick** — curated by us. Default trust posture: slightly
  warmer (no yellow banner on a never-seen fingerprint, since we've
  already vetted it).
- **Community** — signed but uncurated. Listed alphabetically /
  by-install-count, no editorial.

Editorial picks are not paid; we won't take money for placement. If we
ever change that, this paragraph requires a SemVer-major bump on the
RFC.

### 7.4 Aggregate stats only

The registry surfaces install count and weekly-active count per
extension. **No per-user identifiers leave the device.** When the
host fetches a bundle, it sends:

- The bundle id + version.
- An anonymised install-event flag (no IP correlation, no cookies).

The host *never* sends model contents, flavor contents, capability
grants, or any user data.

### 7.5 Takedown

A community-submittable "Report this extension" flow on every listing.
Reports go to a small triage queue. Confirmed abuse:

1. Removed from listings.
2. Fingerprint goes onto the revocation list (the kill-switch hook).
3. A post-mortem published in `docs/security/incidents/`.

## 8. Phase-5 prototype shipped this RFC

To ground the design, this RFC also ships the cryptographic kernel as
code. What's in:

- **`@ifc-lite/extensions/signing`** — `generateKeyPair`,
  `exportKey`, `importKey`, `fingerprint`, `signBundle`, `verifyBundle`,
  `canonicalContentHash`, plus `SignatureMismatchError`,
  `SignatureFormatError`, `KeyFormatError`.
- **`.iflx` envelope update** — `signature` field accepted on unpack,
  emitted on `packSignedBundle`. Unsigned bundles continue to round-trip
  unchanged.
- **CLI** — `ifc-lite ext keygen`, `ifc-lite ext pack`,
  `ifc-lite ext sign`, `ifc-lite ext verify`. The CLI is the on-ramp
  for any author who wants to sign their bundle today, before any
  hosted registry exists.

What's deferred to the Phase-5 build:

- The hosted registry service.
- The TOFU history store in the viewer.
- The "Signers" UI tab.
- Multi-signature envelopes (key rotation transition).
- Registry CI pipeline + lint suite.
- Aggregate-stats pipeline.
- Editorial / community lane separation in a listing UI.

The line is intentional: cryptography is the smallest piece with the
biggest consequences for getting wrong, and it ships now so the design
is exercised against real APIs. Everything above the crypto layer can
iterate without re-rolling key material or breaking signed bundles in
the wild.

## 9. Non-goals (for the registry path)

- **A package manager.** No transitive dependencies. Extensions are
  self-contained bundles.
- **Web of trust.** No "Alice signs Bob's key." Each fingerprint is
  evaluated independently against TOFU history.
- **Paid placement.** Not now, not as a future option.
- **A discussion forum.** Reports + takedown only. Conversations
  happen on the existing GitHub Discussions.
- **Hosting unsigned bundles.** The registry rejects unsigned uploads.
  The user can still side-load unsigned bundles via drag-drop / file
  picker — that's their explicit choice, not a registry feature.

## 10. Open questions (for the registry phase, not blocking now)

1. **Signing service or local-only?** Some authors will not want to
   manage private keys on disk. Phase 5+ may offer a hardware-key-
   backed signing flow (e.g. WebAuthn-bound keys) as an alternative.
   For now: local-key only.
2. **Rate limits for publish?** Per-fingerprint daily cap to deter
   spam. Plumbing is trivial; numbers need tuning against real load.
3. **Storage cost cap.** A bundle is small (~ tens of KB to a few MB);
   storage is cheap. Cost only matters at fairly large fleet sizes.
4. **Federation / mirroring.** Should we publish the registry's data
   as a static manifest others can mirror? Lean yes (it eliminates a
   single point of failure) but no hard commitment.
5. **Kill-switch update channel.** Bundled with host releases vs. a
   live fetch on startup. The static-with-host approach is auditable
   (revocations land in git history) but slower to roll out. Lean
   static for v1.
6. **Public key publication beyond the registry.** Should authors
   ship their fingerprint alongside their published source (e.g.
   GitHub README, NPM trust)? Recommend yes, but the registry's
   `metadata.publicKey` is authoritative.

## 11. Cross-references

- `02-security.md §10` — original supply-chain posture.
- `05-flavors-and-sharing.md §7` — registry sketch for flavors (this
  RFC covers extensions; flavors compose extensions and inherit the
  same signing surface for any bundles they embed).
- `09-implementation-plan.md` — Phase 5 task block (will be expanded
  with the now-prototyped pieces).
