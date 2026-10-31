# @ifc-lite/oci

## 0.2.0

### Minor Changes

- [#8380](https://github.com/LTplus-AG/ifc-lite/pull/8380) [`87d8fdf`](https://github.com/LTplus-AG/ifc-lite/commit/87d8fdf35987b4e8b1f28df297fc2f43aa39dd53) Thanks [@louistrue](https://github.com/louistrue)! - New package: a pull-only OCI distribution client that runs in Node and browsers with an injected `fetch`. It parses `[oci://]host[:port]/repo[:tag][@sha256:…]` references, authenticates from the registry's `WWW-Authenticate` challenge (anonymous, Basic or Bearer, with credentials sent only to the registry or a token realm the caller trusts), lists tags across `Link` pagination, fetches OCI and Docker manifests and indexes, and downloads blobs through manual redirects without forwarding `Authorization`, under a hard size cap with sha256 verification. Failures are reported as `OciError` with a typed `code`.
