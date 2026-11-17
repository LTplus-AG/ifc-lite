# @ifc-lite/oci

## 0.2.0

### Minor Changes

- [#8380](https://github.com/LTplus-AG/ifc-lite/pull/8380) [`87d8fdf`](https://github.com/LTplus-AG/ifc-lite/commit/87d8fdf35987b4e8b1f28df297fc2f43aa39dd53) Thanks [@louistrue](https://github.com/louistrue)! - New package: a pull-only OCI distribution client that runs in Node and browsers with an injected `fetch`. It parses `[oci://]host[:port]/repo[:tag][@sha256:…]` references, authenticates from the registry's `WWW-Authenticate` challenge (anonymous, Basic or Bearer, with credentials sent only to the registry or a token realm the caller trusts), lists tags across `Link` pagination, fetches OCI and Docker manifests and indexes, and downloads blobs through manual redirects without forwarding `Authorization`, under a hard size cap with sha256 verification. Failures are reported as `OciError` with a typed `code`.

- [#8405](https://github.com/LTplus-AG/ifc-lite/pull/8405) [`417877f`](https://github.com/LTplus-AG/ifc-lite/commit/417877fe65f881f9c501799d0fb56ff46dee1ed2) Thanks [@louistrue](https://github.com/louistrue)! - Add push. `OciClient.pushBlob` uploads a blob (skipped when the registry already holds it) with a POST then a single PUT, `pushEmptyConfig` uploads the OCI empty config, and `pushManifest` puts a manifest by tag or digest, refusing to replace an existing tag (`TAG_EXISTS`, a new error code) unless `allowOverwrite` is set. `buildImageManifest` serializes an image manifest deterministically. Pushes request `pull,push` scope under the same credential rules as pulls, never send an upload to another origin, and verify the digest the registry reports.
