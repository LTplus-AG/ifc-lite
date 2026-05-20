# @ifc-lite/embed-sdk

## 1.14.4

### Patch Changes

- [#760](https://github.com/LTplus-AG/ifc-lite/pull/760) [`1282b13`](https://github.com/LTplus-AG/ifc-lite/commit/1282b13fbaf8db90197ebd3d272f59d3031810ed) Thanks [@louistrue](https://github.com/louistrue)! - Ship compiled JavaScript instead of raw TypeScript source.

  Both packages previously published with `main`/`types`/`exports` pointing at
  `./src/index.ts` and no build step, so the tarball contained only
  `src/index.ts`. A plain `npm install` + `import` failed with
  `Unknown file extension ".ts"` in Node, and the packages were fragile under
  `tsc`, Jest, ts-node, and non-esbuild bundlers — despite `@ifc-lite/embed-sdk`
  being intended for external embedding (Power BI, Superset, Grafana).

  They now build with `tsc` to `dist/` and export `./dist/index.js` +
  `./dist/index.d.ts`, matching every other publishable package in the repo.

- Updated dependencies [[`1282b13`](https://github.com/LTplus-AG/ifc-lite/commit/1282b13fbaf8db90197ebd3d272f59d3031810ed)]:
  - @ifc-lite/embed-protocol@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.11.0
