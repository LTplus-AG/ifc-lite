---
"@ifc-lite/geometry": patch
---

Fix consumer build failure when bundling `@ifc-lite/geometry` without
`@ifc-lite/wasm-threaded` installed (issue #676). The single-controller
worker (`geometry-controller.worker.ts`) used to carry a static
`import init, { initSync, IfcAPI, initThreadPool } from '@ifc-lite/wasm-threaded'`
statement which Turbopack / webpack / Vite follow during worker chunking —
that resolves through every consumer's bundler even when
`useSingleController` is never enabled, and the optional peerDep flag
added in #665 only suppresses `pnpm install` warnings, not bundler
resolution. Consumers on Next 16 + Turbopack hit
`Module not found: Can't resolve '@ifc-lite/wasm-threaded'`.

The threaded bundle is intentionally workspace-only (see
`packages/wasm-threaded/package.json` `_intent`; the production path
uses the single-threaded `@ifc-lite/wasm` and the controller is kept as
latent infrastructure per
`docs/architecture/single-controller-rayon-design.md` §12). Switching to
a type-only TSC-erased import plus an indirect runtime `import(<expr>)`
keeps the worker bundler-safe for default consumers while preserving
the opt-in controller path for hosts that alias
`@ifc-lite/wasm-threaded` in their bundler config (e.g. the viewer's
`vite.config.ts` Phase 2 wiring). A new `geometry-controller-dist`
regression test pins the published `dist/geometry-controller.worker.js`
against ever reintroducing a static import of the threaded bundle.
