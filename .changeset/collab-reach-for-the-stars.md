---
"@ifc-lite/collab": minor
"@ifc-lite/collab-server": minor
---

Big reach-for-the-stars batch. Closes (or near-closes) the remaining
substantial items in `docs/architecture/collab-plan.md` for v0.2,
v0.5, v0.7, and v1.0. **+21 tests, total 140 passing.**

`@ifc-lite/collab`
- **History sidecar (v0.7).** `HistorySidecar` interface with
  `MemoryHistorySidecar` ship and an `AutomergeHistorySidecar` slot
  reserved (matching the same interface). Records, time-travels, diffs
  per-entity-id, branches, merges. `attachHistorySidecar(session,
  sidecar, opts)` drives a sidecar from a live `CollabSession` on a
  configurable interval + on demand, with optional differential
  layers in each entry for cheap diff queries.
- **End-to-end encryption (v1.0).** WebCrypto-based suite:
  `deriveRoomKey` (PBKDF2-SHA256, 200k iterations default),
  `generateRoomKey` / `exportRoomKey` / `importRoomKey`,
  `encryptFrame` / `decryptFrame` with versioned
  `[1B ver][12B IV][N B AES-GCM]` framing, and a `KeyRing`
  (`createKeyRing(initial, { gracePeriodMs })`) so in-flight frames
  decode through retired keys for the configured grace window.
- **Presence-renderer math (v0.2).** `peerVisuals(peers, opts)` turns
  a `PresenceMap` into render-ready `{ color, label, opacity,
  isStale, cursor3d, cursor2d, selection, modelId }`. Color resolution
  uses `colorForUser` against either the human or agent palette
  depending on the `(agent)` suffix; opacity fades over `staleAfterMs`.
  `cursorScreenPosition` projects 2D cursors per viewport.

`@ifc-lite/collab-server`
- **S3 persistence (v0.5).** `S3Persistence` against an injectable
  `S3LikeClient` + `S3Commands` shape — AWS SDK, R2, MinIO, or any
  S3-compatible client all fit without forcing
  `@ifc-lite/collab-server` to depend on `@aws-sdk/client-s3`.
  Per-room layout: `<prefix><room>.snap` for compacted state plus
  `<prefix><room>.log/<NNNNNNNNNN>.bin` for rolling log frames.
  Implements load / append / compact / drop with `frameMaxBytes`
  enforcement.
- **Anti-replay wired into the message path (v0.5 / open #8).**
  `RoomOptions.verifyMessage: VerifyMessageFn` runs before rate-limit
  / role-check. Rejects audit as `reject` with the supplied reason.
  `verifyWithReplayProtector(protector, { requireSigned })` adapts the
  existing `ReplayProtector` for the hook. `encodeSignedFrame` /
  `decodeSignedFrame` ship a default
  `[0xff][4B clientId][4B clock][64B HMAC][N B payload]` envelope so
  apps don't have to invent one.
- **TLS / secure-server helpers (v0.5).** `createSecureHttpServer`
  with strong defaults (TLS 1.2+, conservative cipher list, ALPN
  `http/1.1`, optional CA bundle for mTLS), `applySecurityHeaders` for
  the OWASP-baseline response headers (HSTS, no-sniff, frame deny,
  no-referrer), and `secureHttpHandler(inner)` to wrap an existing
  request handler with the headers + TRACE/TRACK rejection.

Tests added (+21):
- `history` — record / list / time-trace, diff added/removed/changed,
  branch + merge, session-driven captures with diff entries.
- `e2e-encryption` — derive → encrypt → decrypt round-trip,
  cross-salt rejection, wrong-key rejection, export/import preserves
  decryption, key ring grace period, post-grace key drop.
- `render` — color/label/opacity resolution, stale fading, local-peer
  exclusion, cursor projection by viewport.
- `replay-wired` — server rejects unsigned frames when
  `requireSigned`, signed frame decodes + clock-tracks, replay
  rejected.
- `secure-server` — security headers applied, TRACE/TRACK rejected
  via raw socket (undici blocks TRACE client-side).
- `persistence-s3` — append + load round-trip, compact replaces snap
  and clears log, drop removes everything.

Plan doc has updated v0.2 / v0.5 / v0.7 / v1.0 status badges. v0.5
and v0.7 and v1.0 are now ☑ on every item that lives inside these
two packages; remaining work for v0.5 (Redis persistence,
full-bucket histograms) and v0.7 (`AutomergeHistorySidecar`) is
opt-in extension that doesn't block GA.
