# @ifc-lite/oci

A pull-only client for OCI distribution registries (GHCR, ECR Public, Docker
Hub's `registry-1.docker.io`, Harbor, `distribution/distribution`, ...). It
lists tags, fetches manifests and indexes, and downloads blobs that are
verified against their descriptor. It has no framework dependency and runs
in Node and in browsers. `fetch` is injected (default `globalThis.fetch`).

It knows nothing about IFC and sets no policy on artifact media types: what
a manifest *means* is the caller's decision.

```ts
import { OciClient, parseReference } from '@ifc-lite/oci';

const ref = parseReference('oci://ghcr.io/acme/tower-model:rev-b');
const client = new OciClient();

const tags = await client.tags(ref);
const { digest, value } = await client.manifest(ref);
if (value.kind === 'manifest') {
  const layer = value.layers[0];
  const bytes = await client.blob(ref, layer, { maxBytes: 512 * 1024 * 1024 });
}
```

## Scope

Provided:
- `parseReference`: `[oci://]host[:port]/repo[:tag][@sha256:<hex>]`, using
  the distribution grammar. The origin is `https:`, or plain `http:` only for
  hosts the caller lists in `insecureHosts` (`host` or `host:port`).
- Challenge-driven auth. Every request starts anonymous. On a 401 the client
  reads `WWW-Authenticate` (Bearer or Basic), authenticates, and retries once.
  It builds the token scope itself (`repository:<repo>:pull`), because
  registries send a placeholder scope in their challenge. A token reply may
  carry `token` or `access_token`. A missing `expires_in` means 60 s. Tokens
  are cached per registry and scope.
- `tags()`: follows `Link: <...>; rel="next"` pagination. Relative links
  resolve against the page URL, absolute links must stay on the registry
  origin, and the walk stops at `maxPages` (default 100).
- `manifest()`: OCI image manifest, OCI index, Docker v2 manifest and Docker
  manifest list. The result's `kind` (`'manifest'` or `'index'`) tells them
  apart. The body is capped at `maxManifestBytes` (default 4 MiB).
- `blob()`: redirects are followed by hand, the body is capped as it
  streams, and the size and sha256 must match the descriptor exactly.
- `OciError` with a typed `code` for every failure.

## Design notes

**Digests come from the bytes.** The manifest digest is always computed
over the bytes received. `Docker-Content-Digest` is only a cross-check: it
must match when present, and is not required (ECR Public omits it). A
reference that pins `@sha256:` must match the computed digest.

**Where credentials go.** This is the security boundary of the package:
- `{ token }` credentials are sent as `Authorization: Bearer` to the
  registry origin only, with no token exchange.
- `{ username, password }` are sent as Basic to the registry origin when it
  issues a Basic challenge. For a Bearer challenge they go to the token realm
  only when the realm is on the registry's own origin, or its origin is in
  `trustedRealms`. Any other realm gets an anonymous token request. A
  registry can name any URL as its realm, so following it with the user's
  password would hand that password to whoever controls the challenge.
- A token realm must be `https:` unless its host is listed insecure, and the
  client does not follow redirects from it.

**Redirects are manual.** Registries send blob downloads to a CDN on another
origin (GHCR answers 307 to a different host). The client requests with
`redirect: 'manual'` and follows up to five hops itself. `Authorization` goes
only to the registry origin and never to a redirect target on another origin.
A hop to plain `http:` is refused unless its host is listed insecure. Node
returns the real 3xx. Browsers return an `opaqueredirect` with the target
hidden, which is reported as `PROTOCOL` because it cannot be followed safely.

**Size limits are hard caps.** A declared `Content-Length` above the cap
fails before the body is read. Otherwise the stream is cancelled as soon as
the running total passes the cap, so an oversized or endless body never
builds up in memory. A blob's cap is `min(maxBytes, descriptor.size)`. A
descriptor that declares more than `maxBytes` fails before any request.

**Hashing.** By default the blob streams into one buffer of the descriptor's
size and WebCrypto hashes that buffer in place, so there is no second
full-size copy. `createHasher` swaps in a streaming hasher that sees each
chunk as it arrives, for a runtime without `crypto.subtle` or for very large
blobs.

**Token expiry.** A token is treated as expired 5 s before its `expires_in`
runs out. A registry that rejects a cached token anyway gets one
re-authentication and one retry, and a second 401 is `UNAUTHORIZED`.

**Errors never carry secrets.** Messages name origins, repositories and
digests, never request headers. A rejected `fetch` (DNS failure, refused
connection, or a browser CORS block, which looks the same from script)
becomes `NETWORK`. A caller's `AbortSignal` abort is rethrown unchanged.

**No implicit registry.** `library/alpine` is rejected rather than resolved
against `docker.io`. A reference names its host.

## Not included on purpose

- Push, delete, `_catalog`, and the referrers API: this client only pulls.
- Docker credential helpers and `~/.docker/config.json`: credentials are the
  caller's to supply.
- Schema-1 Docker manifests, which are deprecated and signed with JWS. They
  are rejected as `UNSUPPORTED_MANIFEST`.
- Platform selection in an index. `OciIndex.manifests` carries each entry's
  `platform` unchanged, and choosing one is the caller's policy.
- Retries with backoff and resumable (`Range`) downloads.
