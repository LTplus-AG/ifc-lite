# @ifc-lite/opencde-foundation

## 0.3.0

### Minor Changes

- [#6911](https://github.com/LTplus-AG/ifc-lite/pull/6911) [`351ea6d`](https://github.com/LTplus-AG/ifc-lite/commit/351ea6d2de55c1121dcced1e6c36b22888707f66) Thanks [@louistrue](https://github.com/louistrue)! - OpenCDE requests accept an `AbortSignal`, a `timeoutMs` limit and extra headers ([#6896](https://github.com/LTplus-AG/ifc-lite/issues/6896)): `FoundationRequestOptions` and `HttpRequestOptions` gain `signal`, `timeoutMs` and (for the former) `headers`, and an already-aborted signal is refused before `fetch` is called. `BcfApiClient`'s read and write methods take an optional trailing `BcfRequestOptions`. A request rejected after dispatch still has an unknown server outcome; callers must reconcile before resending a write. New `topicToApiWrite` and `viewpointToApi` map `@ifc-lite/bcf` topics and viewpoints to BCF API request bodies (client-owned fields only; `default_visibility` is always written because BCF API defaults it to `false`).

## 0.2.0

### Minor Changes

- [#5438](https://github.com/LTplus-AG/ifc-lite/pull/5438) [`3edd57d`](https://github.com/LTplus-AG/ifc-lite/commit/3edd57d9bf0b4fddb28da3401bc5cf0189756729) Thanks [@louistrue](https://github.com/louistrue)! - Add `@ifc-lite/opencde-foundation`: client for the buildingSMART OpenCDE Foundation API — the services and conventions every OpenCDE API (BCF, Documents, ...) shares. Provides `FoundationApiClient` (versioned `{baseUrl}/{version}` request plumbing, Bearer token injection, `/versions`, `/auth` and `/current-user`), `/foundation/versions`-based API discovery (`getFoundationVersions`, `findApiVersion`, `apiBaseUrlFor`), OAuth2 token exchange for the password, refresh, client-credentials and authorization-code grants plus dynamic client registration, and the `FoundationApiError`/`FoundationAuthenticationError` error types.
  
  `@ifc-lite/bcf-api`'s `BcfApiClient` now extends `FoundationApiClient` and its OAuth2/discovery/error code is this package's, re-exported under its historical names — a refactor with no change to `@ifc-lite/bcf-api`'s public API or behaviour (see that package's own changeset).
