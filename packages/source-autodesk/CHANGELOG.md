# @ifc-lite/source-autodesk

## 0.2.0

### Minor Changes

- [#6825](https://github.com/LTplus-AG/ifc-lite/pull/6825) [`08e0910`](https://github.com/LTplus-AG/ifc-lite/commit/08e09105c67fd7858b64184c9a027717a7f9f7ef) Thanks [@louistrue](https://github.com/louistrue)! - Add Autodesk Forma Data Management file sources, Site Design and Data Exchange catalogs with static PKCE or a hosted session gateway. Pin file/proposal revisions and support version selection, remembered sites, preparation/download progress and cancellation. Native resources use the configured Forma converter or snapshot-checked Windows SDK worker; whole-exchange exports support a stable current snapshot only. Hosted imports use session-owned background jobs and an authenticated remote Windows worker for Railway deployments.

### Patch Changes

- [#6909](https://github.com/LTplus-AG/ifc-lite/pull/6909) [`537a454`](https://github.com/LTplus-AG/ifc-lite/commit/537a454d1ec40f5f3722dfc9ebdfd5be478a1ce0) Thanks [@louistrue](https://github.com/louistrue)! - Refresh the hosted Autodesk session before mutations so an expired session or gateway restart does not prevent reconnecting or signing out. Preserve cancellation before authorization.
- Updated dependencies [[`7c00fad`](https://github.com/LTplus-AG/ifc-lite/commit/7c00fadaf7bb702f8fe3d9a98541bd1d3db2d3b2)]:
  - @ifc-lite/plugin-api@0.5.0
  - @ifc-lite/oauth-pkce@0.3.0
