---
"@ifc-lite/geometry": patch
---

Fix `Could not resolve entry module "geometry.worker.ts"` when bundling the
published `@ifc-lite/geometry` package with Vite/Rollup.

`src/geometry-parallel.ts` constructs module workers via
`new Worker(new URL('./geometry.worker.ts', import.meta.url), ...)`. The post-
build step in `package.json` rewrites those `.ts` URLs to `.js` so the npm
tarball ships URLs that point at the emitted file — but the rewrite was only
applied to `dist/index.js`, and the worker URLs live in `dist/geometry-parallel.js`.
Consumers like the `create-ifc-lite` Vite templates therefore tried to load a
`.ts` worker entry that is not present in the tarball and the build failed.

Apply the rewrite to every `.js` file in `dist/`, leaving the source TypeScript
URL unchanged so in-repo Vite builds keep resolving the worker from source.
