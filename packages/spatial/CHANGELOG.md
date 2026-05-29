# @ifc-lite/spatial

## 1.14.6

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/geometry@2.0.0

## 1.14.5

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/geometry@1.16.2

## 1.14.4

### Patch Changes

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix large model loading with streaming columnar parser, inline scan worker, and improved geometry bridge. Refactor relationship graph for better memory efficiency and add spatial index builder utilities.

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Simplify orbit behavior: remove dynamic pivot and use camera target. Update frustum utilities and viewer HTML integration.

- Updated dependencies [[`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515), [`f0da00c`](https://github.com/louistrue/ifc-lite/commit/f0da00c162f2713ed9144691d52c75a21faa18dd)]:
  - @ifc-lite/geometry@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies [[`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/geometry@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.14.2

## 1.14.1

### Patch Changes

- [#290](https://github.com/louistrue/ifc-lite/pull/290) [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0) Thanks [@louistrue](https://github.com/louistrue)! - fix: eliminate facade flickering during orbit and zoom

  - Restore object-ID pass and post-processing during camera interaction (reverts interaction skip that caused visual pop-in)
  - Add PLANE_EPSILON margin to frustum culling plane checks to prevent floating-point jitter from toggling batch visibility at frustum boundaries
  - Skip fresnel glass effects on selected objects so blue highlight renders correctly instead of appearing white

- Updated dependencies [[`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/geometry@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.7.0

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages
