---
"@ifc-lite/geometry": patch
---

Fix consumer build failure when bundling `@ifc-lite/geometry` without
`@ifc-lite/wasm-threaded` installed (issue #676). The published
`dist/geometry-controller.worker.js` used to carry a static
`import init, { initSync, IfcAPI, initThreadPool } from '@ifc-lite/wasm-threaded'`
which Turbopack / webpack / Vite all follow during worker chunking —
the optional peer-dep flag added in #665 only suppresses `pnpm install`
warnings, not bundler resolution. Consumers on Next 16 + Turbopack hit
`Module not found: Can't resolve '@ifc-lite/wasm-threaded'`.

The threaded bundle is intentionally workspace-only (see
`packages/wasm-threaded/package.json` `_intent`; the production path
uses the single-threaded `@ifc-lite/wasm` and the controller is kept as
latent infrastructure per
`docs/architecture/single-controller-rayon-design.md` §12). Resolution
splits across build steps:

- **Source** keeps the static `import … from '@ifc-lite/wasm-threaded'`
  so the workspace build (Vite alias →
  `packages/wasm-threaded/pkg/ifc-lite.js`) still resolves the
  controller-path opt-in correctly. Vite only honors aliases for
  statically-analyzable specifiers, and the viewer toggles the
  controller path via `localStorage['ifc-lite:single-controller']='1'`.
- **Published dist** is post-processed by
  `scripts/transform-controller-worker-dist.mjs` after `tsc`. The
  transform replaces the static line with module-level `let` bindings
  plus a lazy `await import(<runtime-built-specifier>)` loader, and
  injects an `await __loadThreadedModule()` at the top of the `init`
  handler. Consumer bundlers no longer see `@ifc-lite/wasm-threaded` as
  a build-time dependency.

A new `geometry-controller-dist.test.ts` regression test pins both
halves of the contract — no static import in dist, and the lazy loader
is present.
