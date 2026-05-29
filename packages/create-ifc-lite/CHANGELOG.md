# create-ifc-lite

## 1.14.7

### Patch Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, keep the legacy `parse()` adapter on the shared scan path, route LOD exports through shared/adaptive ingestion paths, persist cache entity-index columns to avoid cache reload rescans, and update public docs away from legacy sync parse/geometry paths.

## 1.14.6

### Patch Changes

- [#632](https://github.com/louistrue/ifc-lite/pull/632) [`d1fab87`](https://github.com/louistrue/ifc-lite/commit/d1fab875f680e6b923d3a75d52459fd4514467e6) Thanks [@maxkrut](https://github.com/maxkrut)! - Fix npm package version resolution when scaffolding projects on Windows.

  `create-ifc-lite` resolves published `@ifc-lite/*` package versions by
  calling `npm view` before writing the generated template's `package.json`.
  On Windows, spawning `npm` directly from Node can fail with
  `spawnSync npm ENOENT` because the executable is exposed through the
  shell shim (`npm.cmd`) rather than as a directly spawnable binary in all
  environments. The CLI then reports this as a registry access failure, even
  though `npm view @ifc-lite/geometry version` works from the same terminal.

  Run the npm query through `cmd.exe /c npm ...` on Windows so template
  creation follows the same command resolution path as the user's shell,
  while keeping the direct `npm` spawn path unchanged on other platforms.

## 1.14.5

### Patch Changes

- [#507](https://github.com/louistrue/ifc-lite/pull/507) [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b) Thanks [@louistrue](https://github.com/louistrue)! - Repair create-ifc-lite template scaffolds with installable package versions and dedicated React starter

## 1.14.4

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

## 1.13.0

### Minor Changes

- [#270](https://github.com/louistrue/ifc-lite/pull/270) [`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c) Thanks [@louistrue](https://github.com/louistrue)! - Add Babylon.js viewer template to create-ifc-lite scaffolding

  New `babylonjs` template option for `create-ifc-lite` that generates a complete Babylon.js-based IFC viewer with geometry streaming, selection, and camera controls. Includes full example project and documentation tutorial.

## 1.11.5

### Patch Changes

- [#262](https://github.com/louistrue/ifc-lite/pull/262) [`d204ed8`](https://github.com/louistrue/ifc-lite/commit/d204ed807484a3a6b337a1186dcea311626493ad) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM loading in threejs template: revert to `optimizeDeps.exclude: ['@ifc-lite/wasm']` (matching the working example). `vite-plugin-wasm` was incorrect — the wasm-bindgen `new URL('ifc-lite_bg.wasm', import.meta.url)` pattern works correctly when the package is excluded from Vite pre-bundling.

## 1.11.4

### Patch Changes

- [#260](https://github.com/louistrue/ifc-lite/pull/260) [`e342a43`](https://github.com/louistrue/ifc-lite/commit/e342a430c07b4611b94225a74776e9855bf1450a) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM loading in threejs template: add `vite-plugin-wasm` and `vite-plugin-top-level-await` to vite config. Without these plugins Vite cannot serve the `.wasm` file with the correct `application/wasm` MIME type, causing a `CompileError: wasm validation error` at runtime.

## 1.11.3

### Patch Changes

- [#257](https://github.com/louistrue/ifc-lite/pull/257) [`025d3b1`](https://github.com/louistrue/ifc-lite/commit/025d3b14161e63045f8c79b58b49c7da4d91594b) Thanks [@louistrue](https://github.com/louistrue)! - Fix all template TypeScript errors caught by new CI audit:

  - basic template: add `@types/node` + `types: ["node"]` in tsconfig; fix `Buffer` → `ArrayBuffer` conversion when calling `IfcParser.parse()`
  - Add `test-templates.yml` CI workflow that scaffolds every template, runs `npm install` + `tsc --noEmit` (+ `vite build` for threejs) on every PR touching `packages/create-ifc-lite`

- [#257](https://github.com/louistrue/ifc-lite/pull/257) [`b1dd28b`](https://github.com/louistrue/ifc-lite/commit/b1dd28beccbec361651dc61d71a9b32d12b03071) Thanks [@louistrue](https://github.com/louistrue)! - Fix TypeScript error in generated Three.js template: use non-null assertions on DOM element declarations so type narrowing works across function boundaries.

## 1.11.2

### Patch Changes

- [#251](https://github.com/louistrue/ifc-lite/pull/251) [`a13e5c0`](https://github.com/louistrue/ifc-lite/commit/a13e5c04eaf6369815eb66af5174a724a4e38937) Thanks [@louistrue](https://github.com/louistrue)! - Fix TypeScript errors in generated Three.js template: add explicit type casts for `HTMLCanvasElement` and `HTMLInputElement` DOM queries; disable OrbitControls damping for sharp camera stops.

## 1.8.1

### Patch Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Fix react template generating wrong `@ifc-lite/*` versions in package.json.

  Previously all workspace dependencies were replaced with the latest version of
  `@ifc-lite/parser`, which broke installs when a package (e.g. `@ifc-lite/sandbox`)
  had not yet been published at that version. Each package is now queried
  individually from the npm registry so the generated package.json always
  references the actual published version of every dependency.

## 1.6.1

### Patch Changes

- [#182](https://github.com/louistrue/ifc-lite/pull/182) [`5e78765`](https://github.com/louistrue/ifc-lite/commit/5e78765139b6c9c28612ae3f9e58760ccc9b524e) Thanks [@louistrue](https://github.com/louistrue)! - Fix **APP_VERSION** not defined error in react template by adding Vite define config

## 1.1.8

### Patch Changes

- 8cb195d: Fix Ubuntu setup issues and monorepo resolution.
  - Fix `@ifc-lite/parser` worker resolution for Node.js/tsx compatibility
  - Fix `create-ifc-lite` to properly replace `workspace:` protocol in templates
