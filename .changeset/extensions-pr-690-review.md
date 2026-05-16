---
"@ifc-lite/extensions": minor
---

PR #690 review pass — security and correctness fixes from CodeRabbit.

Critical / security fixes:

- **`capability/match.ts`** — universal wildcard target no longer
  bypasses the required-target check. `model.mutate:*` now correctly
  refuses to cover `model.mutate` (no target). The two are
  structurally different and matching them would silently broaden
  authority. Regression test added.
- **`signing/sign.ts` + `signing/verify.ts`** — `signedAt` is now
  cryptographically bound to the signature via a versioned
  domain-separated message (`iflx-sig\x1fv1\x1f<hash>\x1f<signedAt>`).
  Previously only `contentHash` was signed, so `signedAt` could be
  rewritten post-signing without detection. Regression test added.
- **`signing/keys.ts`** — `importPrivateKey` now enforces
  `kind: 'private'` and wraps base64 / PKCS#8 parse errors in
  `KeyFormatError` rather than letting them bubble up as raw
  WebCrypto exceptions.
- **`apps/viewer/src/services/extensions/host.ts`** — install path
  rejects `grantedCapabilities` not declared by the manifest (closes a
  grant-escalation hole if the review screen pre-filled stale state).
- **`audit/log.ts`** — eviction now uses UTF-8 byte counts (via
  `TextEncoder.encode().byteLength`) instead of UTF-16 string length;
  records are deep-frozen on append so callers can't mutate stored
  events.
- **`bundle/loader.ts`** — added a 16 MiB aggregate bundle cap during
  directory traversal so a thousand 4 MiB files can't OOM the loader.
- **`bundle/iflx.ts`** — base64 decode is now strict (matches the
  base64 alphabet + correct padding) so Node's silently-lossy
  `Buffer.from(b64, 'base64')` no longer accepts corrupted bundles.
- **`migrations/index.ts`** — `manifestVersion` validated as a
  positive integer (rejects `NaN`, `Infinity`, negatives, non-int
  doubles).
- **`manifest/validate.ts`** — extension id regex dropped the `/i`
  flag so the validator actually enforces the lowercase canonical-id
  promise.
- **`host/activation.ts`** — extension is marked `activated` only
  after listeners succeed (a throwing listener used to leave the
  extension permanently uneligible to retry). New `activating` flag
  guards against re-entrant double-dispatch.
- **`host/runtime.ts`** — concurrent `activate()` calls for the same
  id are coalesced via an in-flight Promise map. Previously two
  overlapping calls could both build a sandbox and leak one.
- **`inference/catalogue.ts`** + **`when/eval.ts`** — own-property
  checks instead of `in` / bracket access. Prototype-pollution-style
  lookups like `toString` now return undefined / no capability.
- **`when/eval.ts`** — identifier lookup is gated by the v1 allow-list
  even if the context object happens to carry extra keys.

Correctness / quality fixes:

- **`apps/viewer/.../host.ts`** — `init()` only sets `initialized=true`
  after `loadAll` + `fire('onStartup')` succeed; uninstall explicitly
  deletes the bundle bytes; enable persists `enabled=true` only after
  the loader successfully brings the extension up (rolls back on
  failure); update path snapshots the previous record + bundle bytes
  and restores them if the new bundle fails to load.
- **`idb-storage.ts`** — `onblocked` handler on
  `indexedDB.deleteDatabase` so the recovery rebuild can't hang
  forever when another tab holds a connection. Cascade bundle delete
  rewritten to use a dedicated transaction (the previous version's
  `onsuccess` got clobbered by the shared `runStore` helper).
- **`ext-signing.ts`** — `verify --key <pub>` on an unsigned bundle
  now exits 2 (with structured error in `--json` mode) instead of
  passing silently. `keygen`'s chmod failure logs a warning so users
  on non-POSIX FS aren't quietly left with a 0644 private key.
- **`bundle/iflx.ts`** — signature envelope re-parse failures log a
  warning instead of silently swallowing.
- **`ExtensionsPanel.tsx`** — duplicate install submission guard
  (`busy` check in `handleApprove`); enable/disable/uninstall now
  catch rejections and surface a toast.
- **`useInstalledExtensions.ts`** — `refresh()` wraps `listInstalled()`
  in try/catch (no more unhandled promise rejections).
- **`useSlotContributions.ts`** — refreshes the snapshot synchronously
  when `host` or `slot` changes, so switching slots doesn't show
  stale contributions until the next registry event.
- **`ExtensionHostProvider.tsx`** — async `init()` / `dispose()`
  failures are caught and logged.
- **`sandbox-factory.ts`** — `JSON.stringify` failure in log
  marshalling logs the error instead of silently falling back.
- **`ViewerLayout.tsx`** — mobile bottom sheet title and close
  handler now include the extensions panel (was missed in the UI
  batch).

New tests:
- `capability/match.test.ts` — universal wildcard does NOT cover
  target-less request.
- `signing/signing.test.ts` — signedAt tamper detected by verify.
- `host/activation.test.ts` — listener throw leaves extension
  activatable.
- `host/runtime.test.ts` — concurrent activate() calls coalesce.

Tests: 337 (up from 333 / +4).
